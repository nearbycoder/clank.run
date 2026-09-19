import type { BackendDefinition } from "./backend.js";
import type { AppFixture } from "./blueprint.js";
export declare function createPreviewFixture(definition: BackendDefinition<any, any, any, any>, fixture: AppFixture,
    options: { outputPath: string; password: string; migrations?: string }): Promise<{ protocol: "clank-preview-fixture/1"; users: number; records: number; bytes: number }>;
