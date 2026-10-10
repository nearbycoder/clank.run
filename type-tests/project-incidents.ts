import {createProjectIncidentClient, type ProjectIncidentReference, type ProjectIncidentChange} from "../src/project-incidents.ts";
import type {ClankPlatformOptions} from "../src/platform.ts";
const client = createProjectIncidentClient({timeoutMs: 1000, headers: () => ({authorization: "Bearer scoped-test"})});
const project = "project_fixture_01", incident = "incident_fixture_01";
void client.list(project, {state: "open", after: 1, limit: 25});
void client.read(project, incident, {afterNotes: 2, afterLinks: 3});
void client.create(project, {title: "Recovery", severity: "warning", ownerId: null, operationId: "operation_fixture_01"});
const reference: ProjectIncidentReference = {kind: "job", id: "job_fixture_01", releaseId: "release_fixture_01"};
const change: ProjectIncidentChange = {kind: "link", reference};
void client.change(project, incident, {expectedVersion: 1, operationId: "operation_fixture_02", change});
// @ts-expect-error Private application diagnostics require a release identity.
const missingRelease: ProjectIncidentReference = {kind: "trace", id: "trace_fixture_01"};
// @ts-expect-error Incident links do not accept copied payloads or provider URLs.
const copiedPayload: ProjectIncidentReference = {kind: "error", id: "error_fixture_01", releaseId: "release_fixture_01", payload: "private"};
// @ts-expect-error State transitions have exact typed fields.
const wrongResolution: ProjectIncidentChange = {kind: "resolve", resolution: 12};
void missingRelease; void copiedPayload; void wrongResolution;
const options: ClankPlatformOptions = {dataDirectory: "/trusted/private", publicUrl: "https://control.example.test", incidents: {maxIncidents: 50, maxReceipts: 500, diagnostics: {
  async resolve(projectId, ref, signal) {
    const same: string = ref.releaseId;
    const abort: boolean = signal.aborted;
    // @ts-expect-error Adapters receive scoped identifiers, without application payloads.
    ref.payload;
    void same; void abort;
    return {projectId, reference: ref, available: true, observedAt: Date.now(), state: "running", count: 1};
  },
}}};
void options;
