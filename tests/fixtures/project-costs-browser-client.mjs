import {createAuthClient} from '/runtime/auth.js';
import {createProjectCostClient,createProjectCostView} from '/runtime/project-costs.js';
const status=document.querySelector('#fixture-status'),auth=createAuthClient({immediate:false});let view;
async function run(){
  const user=await auth.login({email:'promotion-owner@example.test',password:'correct horse battery staple'});if(!user?.id)throw new Error('Native HTTP sign-in failed.');
  const stepped=await fetch('/fixture/step-up',{method:'POST',headers:auth.csrfHeader()});if(!stepped.ok)throw new Error('Native fixture UV assertion failed.');
  const {projectId,month}=await (await fetch('/fixture/info')).json();
  const client=createProjectCostClient({auth});view=createProjectCostView(document.querySelector('#view'),{client,projectId,month,getAccountId:()=>auth.user.peek()?.id??null,canManage:()=>true});
  await view.refresh();status.textContent='Native HTTP sign-in and fixture UV assertion passed. Use the production cost controls below. Physical passkey and interactive acceptance are not implied by this setup.';
  document.querySelector('#sign-out').addEventListener('click',async()=>{await auth.logout();view.dispose();status.textContent='Signed out. Private cost metadata and drafts cleared.';});
}
run().catch(error=>{status.textContent='Fixture setup failed: '+String(error.message);view?.dispose();});
