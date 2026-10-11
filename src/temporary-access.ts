import type {AuthClient} from './auth.ts';

export class TemporaryAccessError extends Error {
  declare readonly code: string;
  declare readonly status: number;
  constructor(code: string, message: string, status: number) {super(message);this.name='TemporaryAccessError';this.code=code;this.status=status;}
}

export type TemporaryAccessAction = 'preview.create';
export interface TemporaryAccessGrant {
  readonly id: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly issuerId: string;
  readonly recipientId: string;
  readonly action: TemporaryAccessAction;
  readonly reason: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly version: number;
  readonly state: 'active' | 'revoked' | 'expired';
  readonly active: boolean;
}
export interface TemporaryAccessSnapshot {
  readonly projectId: string;
  readonly version: number;
  readonly observedAt: number;
  readonly grants: readonly TemporaryAccessGrant[];
}
export interface TemporaryAccessCreate {
  readonly recipientId: string;
  readonly action: TemporaryAccessAction;
  readonly durationMs: number;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly operationId: string;
}
export interface TemporaryAccessRevoke {
  readonly grantId: string;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly operationId: string;
}
export interface TemporaryAccessResult {
  readonly grant: TemporaryAccessGrant;
  /** Version at acceptance; read again for the current project version. */
  readonly acceptedVersion: number;
}
export interface TemporaryAccessPreviewCreate {
  readonly grantId: string;
  readonly name: string;
  readonly ttlHours: number;
}
export interface TemporaryAccessPreviewResult {
  readonly id: string;
  readonly parentProjectId: string;
  readonly previewName: string;
  readonly previewExpiresAt: number;
}
export interface TemporaryAccessClient {
  /** Optional for compatibility with grant-management-only clients; never retries creation. */
  createPreview?(projectId: string, input: TemporaryAccessPreviewCreate): Promise<TemporaryAccessPreviewResult>;
  read(projectId: string): Promise<TemporaryAccessSnapshot>;
  create(projectId: string, input: TemporaryAccessCreate): Promise<TemporaryAccessResult>;
  revoke(projectId: string, input: TemporaryAccessRevoke): Promise<TemporaryAccessResult>;
}
export interface TemporaryAccessClientOptions {
  readonly auth: Pick<AuthClient<any>, 'user' | 'session' | 'csrfHeader'>;
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}
export interface TemporaryAccessViewOptions {
  readonly projectId: string;
  readonly client: TemporaryAccessClient;
  readonly account: () => {readonly userId: string; readonly sessionId: string} | null;
  /** Presentation only; the native server independently checks current authority. */
  readonly canManage: () => boolean;
  readonly members: readonly {readonly id: string; readonly label: string}[];
}
export interface TemporaryAccessView {
  readonly disposed: boolean;
  refresh(): Promise<void>;
  hasPendingChanges(): boolean;
  dispose(): void;
}

/** Native controls; exact unknown-response intents are retained for an explicit retry. */
export function createTemporaryAccessView(root: HTMLElement, options: TemporaryAccessViewOptions): TemporaryAccessView {
  const doc=root.ownerDocument, win=doc.defaultView, identity=options.account();
  if (!identity || options.members.length>1000) throw new TypeError('A current account and bounded member list are required.');
  const owner={...identity};let disposed=false,busy=false,dirty=false,previewDirty=false,generation=0,latest:TemporaryAccessSnapshot|null=null;
  let pending:{kind:'create';input:TemporaryAccessCreate}|{kind:'revoke';input:TemporaryAccessRevoke}|null=null;
  let previewIntent:TemporaryAccessPreviewCreate|null=null;
  const node=<T extends keyof HTMLElementTagNameMap>(tag:T,text?:string)=>{const value=doc.createElement(tag);if(text!==undefined)value.textContent=text;return value;};
  const heading=node('h3','Temporary preview access'),copy=node('p','Grant one member time to create a new isolated preview. This does not change their role. All active grants close when the control server restarts.'),status=node('p'),list=node('div'),form=node('form'),recipient=node('select'),duration=node('select'),why=node('input'),submit=node('button','Grant reviewed access'),retry=node('button','Retry unchanged request'),discard=node('button','Discard draft and refresh'),refreshButton=node('button','Refresh grants');
  copy.className='subtle';form.className='invite-form';
  for(const control of [recipient,duration,why])control.className='input';
  submit.className='button';for(const button of [retry,discard,refreshButton])button.className='button secondary';
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.tabIndex=-1;
  recipient.name='temporary-recipient';duration.name='temporary-duration';why.name='temporary-reason';why.maxLength=200;why.required=true;why.autocomplete='off';
  const label=(text:string,control:HTMLElement)=>{const wrapper=node('label',text);wrapper.className='field';wrapper.append(control);form.append(wrapper);};
  const blank=node('option','Select a current member');blank.value='';recipient.append(blank);
  for(const member of options.members){if(member.id===owner.userId)continue;const option=node('option',member.label.slice(0,200));option.value=member.id;recipient.append(option);}
  for(const [value,text]of [['900000','15 minutes'],['1800000','30 minutes'],['3600000','1 hour']]){const option=node('option',text);option.value=value;duration.append(option);}
  recipient.required=true;label('Member',recipient);label('Access duration',duration);label('Approval reason',why);submit.type='submit';form.append(submit);
  for(const button of [retry,discard,refreshButton])button.type='button';retry.hidden=true;
  const previewForm=node('form'),previewGrant=node('select'),previewName=node('input'),previewDuration=node('select'),previewSubmit=node('button','Create new preview'),previewClear=node('button','Clear after outcome review');
  previewForm.name='temporary-preview-form';previewForm.className='invite-form';previewGrant.name='temporary-preview-grant';previewName.name='temporary-preview-name';previewDuration.name='temporary-preview-duration';previewName.maxLength=30;previewName.required=true;previewName.autocomplete='off';previewName.pattern='[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?';previewGrant.required=true;
  for(const control of [previewGrant,previewName,previewDuration])control.className='input';previewSubmit.className='button';previewClear.className='button secondary';previewSubmit.type='submit';previewClear.type='button';
  for(const [value,text]of [['1','1 hour'],['6','6 hours'],['24','24 hours']]){const option=node('option',text);option.value=value;previewDuration.append(option);}
  previewForm.append(node('h4','Use your reviewed access'),node('p','Create a new isolated preview after recent native authentication. The server checks your grant again at creation. Existing previews cannot be refreshed.'));
  for(const [text,control]of [['Active grant',previewGrant],['New preview name',previewName],['Preview lifetime',previewDuration]] as const){const wrapper=node('label',text);wrapper.className='field';wrapper.append(control);previewForm.append(wrapper);}
  previewForm.append(previewSubmit,previewClear);
  root.replaceChildren(heading,copy,status,refreshButton,list,form,retry,discard,previewForm);
  const current=()=>{const value=options.account();return !disposed&&value?.userId===owner.userId&&value.sessionId===owner.sessionId;};
  const hasPendingChanges=()=>dirty||previewDirty||pending!==null||previewIntent!==null;
  const unload=(event:BeforeUnloadEvent)=>{if(current()&&hasPendingChanges()){event.preventDefault();event.returnValue='';}};
  win?.addEventListener('beforeunload',unload);
  const dispose=()=>{if(disposed)return;disposed=true;generation++;clearInterval(timer);win?.removeEventListener('beforeunload',unload);pending=null;previewIntent=null;dirty=false;previewDirty=false;why.value='';recipient.value='';previewName.value='';previewGrant.value='';root.replaceChildren();};
  const controls=()=>{const manage=options.canManage();form.hidden=!manage;for(const control of [recipient,duration,why])control.disabled=busy||pending!==null||!manage;submit.disabled=busy||pending!==null||!latest||!manage;retry.hidden=pending===null;retry.disabled=busy;discard.disabled=busy||pending!==null;refreshButton.disabled=busy;
    const own=latest?.grants.filter(grant=>grant.active&&grant.recipientId===owner.userId&&grant.expiresAt>latest!.observedAt)??[];
    previewForm.hidden=!options.client.createPreview||(!own.length&&!previewIntent);
    for(const control of [previewGrant,previewName,previewDuration])control.disabled=busy||pending!==null||previewIntent!==null;
    previewSubmit.disabled=busy||pending!==null||previewIntent!==null||!own.length;previewClear.hidden=previewIntent===null;previewClear.disabled=busy;
  };
  const render=()=>{
    if(!latest)return;list.replaceChildren();
    for(const grant of latest.grants){const row=node('article'),title=node('h4',grant.action==='preview.create'?'Create a new preview':'Unavailable action');row.className='panel section-gap';
      const member=options.members.find(item=>item.id===grant.recipientId),details=node('p',(member?.label??'Current member')+' · '+grant.state+' · until '+new Date(grant.expiresAt).toLocaleString()),reason=node('p',grant.reason);row.append(title,details,reason);
      if(grant.active&&options.canManage()){const revoke=node('button','Revoke access');revoke.type='button';revoke.disabled=busy||pending!==null;revoke.addEventListener('click',()=>{if(!current()||busy||pending||!latest)return;const value=win?.prompt('Reason for revoking this access:');if(!value)return;pending={kind:'revoke',input:{grantId:grant.id,reason:value.trim(),expectedVersion:latest.version,operationId:win?.crypto.randomUUID()??crypto.randomUUID()}};void run();});row.append(revoke);}
      if(grant.active&&grant.recipientId===owner.userId)row.append(node('p','Recent native authentication is required to use this grant. It permits creation only; existing previews cannot be refreshed.'));
      list.append(row);
    }
    const selected=previewGrant.value;previewGrant.replaceChildren();const empty=node('option','Select your active grant');empty.value='';previewGrant.append(empty);
    for(const grant of latest.grants){if(!grant.active||grant.recipientId!==owner.userId||grant.expiresAt<=latest.observedAt)continue;const option=node('option',grant.reason+' · until '+new Date(grant.expiresAt).toLocaleString());option.value=grant.id;previewGrant.append(option);}
    previewGrant.value=latest.grants.some(grant=>grant.id===selected&&grant.active&&grant.recipientId===owner.userId)?selected:'';
    if(!previewIntent&&selected&&!previewGrant.value){previewName.value='';previewDirty=false;}
    if(!latest.grants.length)list.append(node('p','No retained temporary access for this account.'));controls();
  };
  const reportFailure=(error:unknown,mutation:boolean)=>{
    const value=error as {status?:number};if([401,403,404].includes(value?.status??0)){dispose();return;}
    if(mutation&&value?.status&&value.status>=400&&value.status<500)pending=null;
    status.textContent=previewIntent?'Preview outcome unknown for '+previewIntent.name+'. Ask an authorized operator to check this exact name before another creation. This form will not retry.':pending?'Acknowledgment unknown. Read current grants, then retry the unchanged request.':'Access could not be updated. Review current grants and native authentication before trying again.';status.focus();
  };
  const refresh=async()=>{
    if(!current()){dispose();return;}const request=++generation;
    try{const snapshot=await options.client.read(options.projectId);if(!current()){dispose();return;}if(request!==generation)return;latest=snapshot;if(!busy&&!pending&&!previewIntent)status.textContent='Grant inventory version '+snapshot.version+'.';render();}
    catch(error){if(current()&&request===generation)reportFailure(error,false);else if(!current())dispose();}
  };
  const run=async()=>{
    if(!current()){dispose();return;}if(busy||!pending)return;busy=true;controls();render();const intent=pending;
    try{await (intent.kind==='create'?options.client.create(options.projectId,intent.input):options.client.revoke(options.projectId,intent.input));if(!current()){dispose();return;}pending=null;dirty=false;why.value='';status.textContent='Reviewed access change acknowledged.';status.focus();}
    catch(error){if(current())reportFailure(error,true);else dispose();}
    finally{busy=false;if(current()){controls();await refresh();}}
  };
  for(const control of [recipient,duration,why])control.addEventListener('input',()=>{if(!busy&&!pending)dirty=true;});
  form.addEventListener('submit',event=>{event.preventDefault();if(!current()||busy||pending||!latest||!options.canManage())return;const approval=why.value.trim();if(!recipient.value||!approval){status.textContent='Choose a member and record an approval reason.';status.focus();return;}pending={kind:'create',input:{recipientId:recipient.value,action:'preview.create',durationMs:Number(duration.value),reason:approval,expectedVersion:latest.version,operationId:win?.crypto.randomUUID()??crypto.randomUUID()}};void run();});
  retry.addEventListener('click',()=>{void run();});refreshButton.addEventListener('click',()=>{void refresh();});discard.addEventListener('click',()=>{if(busy||pending||!current())return;if(dirty&&!win?.confirm('Discard this temporary-access draft?'))return;dirty=false;why.value='';recipient.value='';status.focus();void refresh();});
  for(const control of [previewGrant,previewName,previewDuration])control.addEventListener('input',()=>{if(!busy&&!previewIntent)previewDirty=true;});
  previewForm.addEventListener('submit',event=>{event.preventDefault();if(!current()||busy||pending||previewIntent||!latest||!options.client.createPreview)return;
    const selected=latest.grants.find(grant=>grant.id===previewGrant.value&&grant.active&&grant.recipientId===owner.userId&&grant.expiresAt>latest!.observedAt),name=previewName.value.trim();
    if(!selected||!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(name)){status.textContent='Choose your active grant and a new name using lowercase letters, numbers or interior hyphens.';status.focus();return;}
    const intent={grantId:selected.id,name,ttlHours:Number(previewDuration.value)};previewIntent=intent;busy=true;controls();
    void (async()=>{try{const result=await options.client.createPreview!(options.projectId,intent);if(!current()){dispose();return;}previewIntent=null;previewDirty=false;previewName.value='';status.textContent='New preview '+result.previewName+' created. Its expiry is '+new Date(result.previewExpiresAt).toLocaleString()+'.';status.focus();}
      catch(error){if(!current()){dispose();return;}const code=(error as {status?:number}).status;if([401,403,404].includes(code??0)){dispose();return;}if(code&&code>=400&&code<500){previewIntent=null;status.textContent='Creation was refused. Review current grants, authentication, quotas and whether that name already exists.';}else status.textContent='Preview outcome unknown for '+intent.name+'. Ask an authorized operator to check this exact name before another creation. This form will not retry.';status.focus();}
      finally{busy=false;if(current())controls();}})();
  });
  previewClear.addEventListener('click',()=>{if(!current()||busy||!previewIntent)return;if(!win?.confirm('Have you reviewed the outcome for '+previewIntent.name+' with an authorized operator? Clear only after that review.'))return;previewIntent=null;previewDirty=false;previewName.value='';previewGrant.value='';status.textContent='Reviewed outcome cleared. Choose an active grant before another creation.';status.focus();controls();});
  const timer=setInterval(()=>{if(!current())dispose();else if(!busy)void refresh();},5000);controls();void refresh();
  return {get disposed(){return disposed;},refresh,hasPendingChanges,dispose};
}

/** Always rebind to the current native human session; no shared bearer credential. */
export function createTemporaryAccessClient(options: TemporaryAccessClientOptions): TemporaryAccessClient & Required<Pick<TemporaryAccessClient, 'createPreview'>> {
  const timeout = options.timeoutMs ?? 15000, transport = options.fetch ?? globalThis.fetch;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000) throw new TypeError('Invalid temporary access timeout.');
  const request = async (projectId: string, operation: string, input?: unknown, preview?: TemporaryAccessPreviewCreate): Promise<any> => {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(projectId)) throw new TypeError('Invalid project ID.');
    const userId = options.auth.user.peek()?.id, sessionId = options.auth.session.peek()?.id;
    if (!userId || !sessionId) throw new TemporaryAccessError('UNAUTHENTICATED', 'Sign in to review temporary access.', 401);
    const current = () => options.auth.user.peek()?.id === userId && options.auth.session.peek()?.id === sessionId;
    const encodedInput=input===undefined?undefined:JSON.stringify(input);
    if(encodedInput!==undefined&&new TextEncoder().encode(encodedInput).byteLength>8192)throw new TemporaryAccessError('TEMPORARY_ACCESS_INPUT','Temporary access input exceeds its bound.',422);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => {controller.abort();reject(new TemporaryAccessError('TEMPORARY_ACCESS_TIMEOUT', 'Temporary access request timed out. Read current grants before retrying.', 504));}, timeout); });
    const work = async () => {
      const response = await transport(`${options.url ?? ''}/api/projects/${projectId}/${preview ? 'previews' : 'temporary-access'+operation}`, {method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal, headers: input === undefined ? {} : {'content-type':'application/json', ...options.auth.csrfHeader(), ...(preview ? {'x-clank-temporary-access':preview.grantId} : {})}, ...(input === undefined ? {} : {body: encodedInput})});
      let text = '', bytes = 0; const reader = response.body?.getReader(), decoder = new TextDecoder('utf-8', {fatal:true});
      try {
        if (reader) for (;;) {const part = await reader.read();if (part.done) break;bytes += part.value.byteLength;if (bytes > 65536) throw new TemporaryAccessError('TEMPORARY_ACCESS_RESPONSE', 'Temporary access response exceeds its bound.', 502);text += decoder.decode(part.value, {stream:true});}
        text += decoder.decode();
      } catch {throw new TemporaryAccessError('TEMPORARY_ACCESS_RESPONSE', 'Invalid temporary access response.', 502);}
      finally {if (reader) {void reader.cancel().catch(() => {});reader.releaseLock();}}
      if (!current()) throw new TemporaryAccessError('AUTH_CHANGED', 'Account changed before temporary access completed.', 409);
      let body: any;try {body = JSON.parse(text);}catch {throw new TemporaryAccessError('TEMPORARY_ACCESS_RESPONSE', 'Invalid temporary access response.', 502);}
      if (!response.ok || body?.ok !== true) throw new TemporaryAccessError(typeof body?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(body.error.code) ? body.error.code : 'TEMPORARY_ACCESS_FAILED', 'Temporary access request failed. Review current authority and grants.', response.status);
      if (preview) {
        const value=body.preview;
        if (response.status!==201 || body.created!==true || !value || typeof value.id!=='string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.id) || value.parentProjectId!==projectId || value.previewName!==preview.name || !Number.isSafeInteger(value.previewExpiresAt) || value.previewExpiresAt<1) throw new TemporaryAccessError('TEMPORARY_ACCESS_RESPONSE','Invalid new preview acknowledgment. Review the submitted name before another creation.',502);
        return {id:value.id,parentProjectId:value.parentProjectId,previewName:value.previewName,previewExpiresAt:value.previewExpiresAt};
      }
      if (input === undefined) {
        if (body.snapshot?.projectId !== projectId || !Number.isSafeInteger(body.snapshot.version) || body.snapshot.version < 0 || !Number.isSafeInteger(body.snapshot.observedAt) || !Array.isArray(body.snapshot.grants) || body.snapshot.grants.length > 100) throw new TemporaryAccessError('TEMPORARY_ACCESS_RESPONSE', 'Invalid temporary access inventory.', 502);
        for (const grant of body.snapshot.grants) validateTemporaryAccessGrant(grant, projectId);
        return body.snapshot;
      }
      validateTemporaryAccessGrant(body.result?.grant, projectId);
      if (!Number.isSafeInteger(body.result?.acceptedVersion) || body.result.acceptedVersion < 1) throw new TemporaryAccessError('TEMPORARY_ACCESS_RESPONSE', 'Invalid temporary access receipt.', 502);
      return body.result;
    };
    try {return await Promise.race([work(), expired]);}finally {clearTimeout(timer);controller.abort();}
  };
  return {createPreview: async (id,input) => {
    if (!input || typeof input.grantId!=='string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(input.grantId) || typeof input.name!=='string' || !/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(input.name) || !Number.isSafeInteger(input.ttlHours) || input.ttlHours<1 || input.ttlHours>8760) throw new TemporaryAccessError('TEMPORARY_ACCESS_INPUT','Choose an exact lowercase preview name, current grant and bounded lifetime.',422);
    const reviewed={grantId:input.grantId,name:input.name,ttlHours:input.ttlHours};
    return request(id,'',{name:reviewed.name,ttlHours:reviewed.ttlHours},reviewed);
  },read: id => request(id, ''), create: (id, input) => request(id, '', input), revoke: (id, input) => request(id, '/revoke', input)};
}

/** Validates untrusted transport/state before display; never proves authority. */
export function validateTemporaryAccessGrant(value: any, projectId: string): asserts value is TemporaryAccessGrant {
  const identifier = (input: unknown) => typeof input === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(input);
  if (!value || value.projectId !== projectId || ![value.id, value.projectId, value.organizationId, value.issuerId, value.recipientId].every(identifier) || value.action !== 'preview.create' || typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 200 || /[\u0000-\u001f\u007f]/u.test(value.reason) || !Number.isSafeInteger(value.version) || value.version < 1 || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 3600000 || !['active','revoked','expired'].includes(value.state) || typeof value.active !== 'boolean' || value.active && value.state !== 'active') throw new TemporaryAccessError('TEMPORARY_ACCESS_RESPONSE', 'Invalid temporary access grant.', 502);
}
