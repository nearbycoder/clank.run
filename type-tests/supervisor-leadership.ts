import {openPlatform,type PlatformSupervisorOptions,type PlatformSupervisorStatus} from '@clank.run/framework/platform';
import {openPlatform as root} from '@clank.run/framework';
const supervisor:PlatformSupervisorOptions={configurationId:'local-linux-control',configurationRevision:1,leaseMs:15000,pollIntervalMs:500};
const options={dataDirectory:'/srv/clank',publicUrl:'https://control.example.test',supervisor};
openPlatform(options).then(platform=>{
  const status:PlatformSupervisorStatus|undefined=platform.supervisor?.();
  if(status){const epoch:number=status.epoch,state:PlatformSupervisorStatus['state']=status.state;
    // @ts-expect-error Local status is immutable metadata, not ownership authority.
    status.epoch=99;
    // @ts-expect-error The fixed responsibility set cannot be expanded by a consumer.
    status.responsibilities.push('foreign-task');
    // @ts-expect-error Status contains no credential or takeover capability.
    status.renew();void [epoch,state];
  }
  platform.close();
});
root(options);
// @ts-expect-error Every cluster configuration identifies its explicit revision.
const unversioned:PlatformSupervisorOptions={configurationId:'cluster'};
// @ts-expect-error A browser preference cannot force leadership.
const forced:PlatformSupervisorOptions={...supervisor,forceLeader:true};
// @ts-expect-error Lease duration is a bounded number validated at runtime.
const invalid:PlatformSupervisorOptions={...supervisor,leaseMs:'forever'};
void [unversioned,forced,invalid];
