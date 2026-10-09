import {createAuthClient} from '/dist/auth.js';
import {AccountSecurity,createOrganizationIdentityClient} from '/dist/account-security.js';
import {h,render} from '/dist/dom.js';
const auth=createAuthClient({immediate:false}),identities=createOrganizationIdentityClient({auth});
render(document.querySelector('#app'),h(AccountSecurity,{auth,identities}));await auth.reload();
const status=document.querySelector('#fixture-status');
async function fixture(path){const response=await fetch('/fixture/'+path,{method:'POST',headers:auth.csrfHeader()});if(!response.ok)throw Error('Fixture action requires a current browser session');return response.json()}
document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();try{await auth.login({email:document.querySelector('#email').value,password:document.querySelector('#password').value});status.textContent='Fixture signed in.'}catch(error){status.textContent=error.message}finally{document.querySelector('#password').value='';document.querySelector('#mail-code').textContent=''}});
document.querySelector('#mailbox').onclick=async()=>{try{document.querySelector('#mail-code').textContent='Disposable verification code: '+(await fixture('mailbox')).code}catch(error){status.textContent=error.message}};
document.querySelector('#lose-unlink').onclick=async()=>{try{await fixture('lose-unlink-response');status.textContent='Next accepted unlink response will be lost.'}catch(error){status.textContent=error.message}};
document.querySelector('#revoke-inventory').onclick=async()=>{try{await fixture('revoke-inventory');status.textContent='Next identity inventory will encounter a real session revocation.'}catch(error){status.textContent=error.message}};
document.querySelector('#signout').onclick=async()=>{await auth.logout();status.textContent='Fixture signed out.';document.querySelector('#mail-code').textContent=''};
auth.user.subscribe(()=>{document.querySelector('#mail-code').textContent=''});
