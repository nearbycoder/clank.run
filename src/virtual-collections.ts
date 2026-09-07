export type VirtualKey = string | number;
export interface VirtualItem<Value> { readonly key: VirtualKey; readonly index: number; readonly value: Value; readonly offset: number; }
export interface VirtualSnapshot<Value> { readonly items: readonly VirtualItem<Value>[]; readonly count: number; readonly totalHeight: number; readonly scrollTop: number; readonly activeIndex: number; readonly rowHeight: number; }
export interface VirtualCollection<Value> {
  snapshot(): VirtualSnapshot<Value>;
  setItems(items: readonly Value[]): void;
  setViewport(scrollTop: number, height: number): void;
  focus(index: number): void;
  navigate(key: string): boolean;
  subscribe(listener: () => void): () => void;
}

/** Fixed-height virtualization with stable-key scroll anchoring and a retained focused row. */
export function createVirtualCollection<Value>(options: { items: readonly Value[]; key: (value: Value) => VirtualKey; rowHeight: number; overscan?: number }): VirtualCollection<Value> {
  const size = options.rowHeight, overscan = options.overscan ?? 3;
  if (!Number.isFinite(size) || size < 16 || size > 1000 || !Number.isSafeInteger(overscan) || overscan < 0 || overscan > 50 || typeof options.key !== "function") throw new TypeError("Virtual rows need a height of 16–1000 and overscan of 0–50.");
  let items: readonly Value[] = [], keys: VirtualKey[] = [];
  let top = 0, height = 0, active = -1;
  const listeners = new Set<() => void>();
  const clamp = () => { top = Math.max(0,Math.min(top,Math.max(0,items.length*size-height))); };
  const emit = () => { for (const listener of listeners) listener(); };
  const collection: VirtualCollection<Value> = {
    snapshot() {
      const first = Math.max(0,Math.floor(top/size)-overscan);
      const last = Math.min(items.length,Math.ceil((top+height)/size)+overscan);
      const indexes = Array.from({length:Math.max(0,last-first)},(_,offset)=>first+offset);
      if (active >= 0 && !indexes.includes(active)) indexes.push(active);
      return Object.freeze({items:Object.freeze(indexes.sort((a,b)=>a-b).map(index=>Object.freeze({key:keys[index]!,index,value:items[index]!,offset:index*size}))),count:items.length,totalHeight:items.length*size,scrollTop:top,activeIndex:active,rowHeight:size});
    },
    setItems(next) {
      if (!Array.isArray(next) || next.length > 100_000 || next.length*size > 16_000_000) throw new TypeError("Virtual collection exceeds supported scroll dimensions.");
      const nextKeys: VirtualKey[] = [], nextMap = new Map<VirtualKey,number>();
      next.forEach((value,index)=>{ const key=options.key(value); if ((typeof key !== "string" && typeof key !== "number") || (typeof key === "string" && (!key || key.length>256)) || (typeof key === "number" && !Number.isSafeInteger(key)) || nextMap.has(key)) throw new TypeError("Virtual row keys must be unique bounded strings or safe integers."); nextKeys.push(key);nextMap.set(key,index); });
      const anchor = keys[Math.floor(top/size)], remainder = top%size, focused=keys[active];
      if (anchor !== undefined && nextMap.has(anchor)) top=nextMap.get(anchor)!*size+remainder;
      active = focused !== undefined && nextMap.has(focused) ? nextMap.get(focused)! : Math.min(Math.max(active,0),next.length-1);
      items=[...next];keys=nextKeys;clamp();emit();
    },
    setViewport(scrollTop, viewportHeight) {
      if (!Number.isFinite(scrollTop) || !Number.isFinite(viewportHeight) || viewportHeight<0 || viewportHeight>100_000) throw new TypeError("Invalid virtual viewport.");
      const oldTop=top,oldHeight=height;top=scrollTop;height=viewportHeight;clamp();if(oldTop!==top||oldHeight!==height)emit();
    },
    focus(index) {
      if(!Number.isSafeInteger(index))throw new TypeError("Invalid virtual focus index.");
      active=items.length?Math.max(0,Math.min(items.length-1,index)):-1;
      if(active>=0){if(active*size<top)top=active*size;else if((active+1)*size>top+height)top=(active+1)*size-height;clamp();}emit();
    },
    navigate(key) {
      const step=Math.max(1,Math.floor(height/size));
      const target=key==="ArrowDown"?active+1:key==="ArrowUp"?active-1:key==="PageDown"?active+step:key==="PageUp"?active-step:key==="Home"?0:key==="End"?items.length-1:undefined;
      if(target===undefined)return false;collection.focus(target);return true;
    },
    subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
  };
  collection.setItems(options.items);
  return collection;
}

export interface VirtualRow<Value> { readonly element: HTMLElement; update(value: Value, index: number): void; dispose?(): void; }
export interface MountedVirtualCollection<Value> { readonly model: VirtualCollection<Value>; readonly viewport: HTMLElement; dispose(): void; }

/** Mount a keyboard-accessible list or grid; grid renderers provide cells with role=gridcell. */
export function mountVirtualCollection<Value>(container: HTMLElement, options: { items: readonly Value[]; key: (value: Value) => VirtualKey; rowHeight: number; overscan?: number; label: string; role?: "list" | "grid"; render: (value: Value,index: number) => VirtualRow<Value> }): MountedVirtualCollection<Value> {
  if (!options.label || options.label.length>256 || (options.role!==undefined && !["list","grid"].includes(options.role)))throw new TypeError("An accessible label and list/grid role are required.");
  const model=createVirtualCollection(options),doc=container.ownerDocument,role=options.role??"list";
  const viewport=doc.createElement("div"),canvas=doc.createElement("div");
  viewport.setAttribute("role",role);viewport.setAttribute("aria-label",options.label);viewport.tabIndex=0;
  viewport.style.cssText="height:100%;overflow:auto;position:relative;overflow-anchor:none;";
  canvas.style.cssText="position:relative;width:100%;";
  if(role==="grid")canvas.setAttribute("role","rowgroup");else canvas.setAttribute("role","presentation");
  viewport.append(canvas);container.append(viewport);
  const mounted=new Map<VirtualKey,{wrapper:HTMLElement;row:VirtualRow<Value>;value:Value;index:number}>();
  let disposed=false,rendering=false;
  const render=()=>{
    if(disposed||rendering)return;rendering=true;
    try{
      const snapshot=model.snapshot(),needed=new Set(snapshot.items.map(item=>item.key));
      const hadFocus=viewport.contains(doc.activeElement);
      let removedFocus=false;
      for(const [key,mount]of mounted)if(!needed.has(key)){removedFocus ||= mount.wrapper.contains(doc.activeElement);mount.row.dispose?.();mount.wrapper.remove();mounted.delete(key);}
      canvas.style.height=`${snapshot.totalHeight}px`;
      if(role==="grid")viewport.setAttribute("aria-rowcount",String(snapshot.count));
      viewport.scrollTop=snapshot.scrollTop;
      for(const item of snapshot.items){
        let mount=mounted.get(item.key);
        if(!mount){const row=options.render(item.value,item.index);const wrapper=doc.createElement("div");wrapper.setAttribute("role",role==="grid"?"row":"listitem");wrapper.style.cssText="position:absolute;left:0;width:100%;box-sizing:border-box;";wrapper.append(row.element);mount={wrapper,row,value:item.value,index:item.index};mounted.set(item.key,mount);canvas.append(wrapper);}
        else if(mount.value!==item.value||mount.index!==item.index){mount.row.update(item.value,item.index);mount.value=item.value;mount.index=item.index;}
        mount.wrapper.style.top=`${item.offset}px`;mount.wrapper.style.height=`${snapshot.rowHeight}px`;mount.wrapper.tabIndex=item.index===snapshot.activeIndex?0:-1;
        mount.wrapper.setAttribute("data-virtual-index",String(item.index));
        if(role==="grid")mount.wrapper.setAttribute("aria-rowindex",String(item.index+1));else{mount.wrapper.setAttribute("aria-posinset",String(item.index+1));mount.wrapper.setAttribute("aria-setsize",String(snapshot.count));}
      }
      // Match DOM reading order after insertions/reorders while retaining row identity.
      let before:ChildNode|null=null;
      for(const item of [...snapshot.items].reverse()){const node=mounted.get(item.key)!.wrapper;if(node.nextSibling!==before)canvas.insertBefore(node,before);before=node;}
      if(hadFocus&&removedFocus){const active=snapshot.items.find(item=>item.index===snapshot.activeIndex);(active?mounted.get(active.key)!.wrapper:viewport).focus({preventScroll:true});}
    }finally{rendering=false;}
  };
  const resize=()=>model.setViewport(viewport.scrollTop,viewport.clientHeight);
  const scroll=()=>model.setViewport(viewport.scrollTop,viewport.clientHeight);
  const keydown=(event:KeyboardEvent)=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    if(event.target!==viewport && !(event.target instanceof doc.defaultView!.HTMLElement && event.target.parentElement===canvas))return;
    if(!model.navigate(event.key))return;event.preventDefault();render();const snapshot=model.snapshot();const item=snapshot.items.find(item=>item.index===snapshot.activeIndex);if(item)mounted.get(item.key)!.wrapper.focus({preventScroll:true});
  };
  const focusin=(event:FocusEvent)=>{const row=[...mounted.values()].find(mount=>mount.wrapper===event.target);if(row&&model.snapshot().activeIndex!==row.index)model.focus(row.index);};
  const stop=model.subscribe(render);
  viewport.addEventListener("scroll",scroll,{passive:true});viewport.addEventListener("keydown",keydown);viewport.addEventListener("focusin",focusin);
  const Observer=doc.defaultView?.ResizeObserver;
  const observer=Observer?new Observer(resize):undefined;observer?.observe(viewport);doc.defaultView?.addEventListener("resize",resize);
  const dispose=()=>{if(disposed)return;disposed=true;stop();observer?.disconnect();doc.defaultView?.removeEventListener("resize",resize);viewport.removeEventListener("scroll",scroll);viewport.removeEventListener("keydown",keydown);viewport.removeEventListener("focusin",focusin);const errors:unknown[]=[];for(const mount of mounted.values())try{mount.row.dispose?.();}catch(error){errors.push(error);}mounted.clear();viewport.remove();if(errors.length)throw new AggregateError(errors,"Virtual row cleanup failed.");};
  try{resize();render();}catch(error){try{dispose();}catch{}throw error;}
  return{model,viewport,dispose};
}
