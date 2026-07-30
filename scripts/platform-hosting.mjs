const HOSTING_PROFILES = new Set(["trusted", "isolated"]);
const RUNNER_KINDS = new Set(["process", "docker"]);

/**
 * Resolve the operator's deployment trust boundary before the control plane
 * opens storage or starts a listener.
 *
 * Development remains zero-setup and trusted. Production defaults to the
 * isolated profile and Docker so a missing variable cannot silently select
 * the process runner.
 */
export function resolvePlatformHosting(environment, signupSetting) {
  const configuredProfile = value(environment, "CLANK_HOSTING_PROFILE", "PROACT_HOSTING_PROFILE");
  if (configuredProfile && !HOSTING_PROFILES.has(configuredProfile)) {
    throw new Error("CLANK_HOSTING_PROFILE must be trusted or isolated.");
  }

  const configuredRunner = value(environment, "CLANK_RUNNER", "PROACT_RUNNER");
  if (configuredRunner && !RUNNER_KINDS.has(configuredRunner)) {
    throw new Error("CLANK_RUNNER must be process or docker.");
  }

  const hostingProfile = configuredProfile
    ?? (configuredRunner === "docker" || environment.NODE_ENV === "production" ? "isolated" : "trusted");
  const runnerKind = configuredRunner ?? (hostingProfile === "isolated" ? "docker" : "process");

  if (hostingProfile === "isolated" && runnerKind !== "docker") {
    throw new Error(
      "The isolated hosting profile requires CLANK_RUNNER=docker. "
      + "Use CLANK_HOSTING_PROFILE=trusted only when every deployer and application is trusted.",
    );
  }
  if (signupSetting === "public" && hostingProfile !== "isolated") {
    throw new Error(
      "CLANK_SIGNUP=public requires CLANK_HOSTING_PROFILE=isolated. "
      + "The trusted profile is limited to bootstrap, disabled, or invitation-controlled onboarding.",
    );
  }

  return Object.freeze({ hostingProfile, runnerKind });
}

export function resolveRunnerArtifactStorage(environment) {
  const mode = environment.CLANK_RUNNER_ARTIFACT_STORE ?? "local";
  if (mode === "local") return null;
  if (mode !== "s3") {
    throw new Error("CLANK_RUNNER_ARTIFACT_STORE must be local or s3.");
  }
  return Object.freeze({
    namespace: required(
      environment,
      "CLANK_RUNNER_ARTIFACT_NAMESPACE",
      undefined,
      "runner artifact storage",
    ),
    options: s3Options(
      environment,
      positiveNumber(environment.CLANK_RUNNER_MAX_ARTIFACT_BYTES, 100 * 1024 * 1024),
      "runner artifact storage",
    ),
  });
}

/**
 * Provider placement is deliberately opt-in. Setting the default to `local`
 * enables explicit per-project provider selection without moving existing or
 * newly created projects unless the caller requests it.
 */
export function resolveProviderPlacement(environment) {
  const defaultPlacement = environment.CLANK_PROVIDER_DEFAULT_PLACEMENT;
  if (defaultPlacement === undefined || defaultPlacement === "") return null;
  if (defaultPlacement !== "local" && defaultPlacement !== "provider") {
    throw new Error("CLANK_PROVIDER_DEFAULT_PLACEMENT must be local or provider.");
  }
  return Object.freeze({
    default: defaultPlacement,
    ...(environment.CLANK_PROVIDER_REGION
      ? { region: environment.CLANK_PROVIDER_REGION }
      : {}),
    labels: exactLabels(environment.CLANK_PROVIDER_LABELS),
    allowedProviderHosts: commaList(environment.CLANK_PROVIDER_ALLOWED_HOSTS),
    activationTimeoutMs: positiveNumber(
      environment.CLANK_PROVIDER_ACTIVATION_TIMEOUT_MS,
      2 * 60_000,
    ),
    maxRuntimeBytes: positiveNumber(
      environment.CLANK_RUNNER_MAX_RUNTIME_BYTES,
      768 * 1024 * 1024,
    ),
    maxDatabaseBytes: positiveNumber(
      environment.CLANK_PROVIDER_MAX_DATABASE_BYTES,
      512 * 1024 * 1024,
    ),
  });
}

export function resolveBackupStorage(environment) {
  const mode = environment.CLANK_BACKUP_STORE ?? "local";
  if (mode === "local") return null;
  if (mode !== "s3") {
    throw new Error("CLANK_BACKUP_STORE must be local or s3.");
  }
  const chunkBytes = positiveNumber(
    environment.CLANK_BACKUP_CHUNK_BYTES,
    8 * 1024 * 1024,
  );
  if (chunkBytes < 64 * 1024 || chunkBytes > 64 * 1024 * 1024) {
    throw new Error("CLANK_BACKUP_CHUNK_BYTES must be from 65536 to 67108864.");
  }
  return Object.freeze({
    namespace: required(
      environment,
      "CLANK_BACKUP_NAMESPACE",
      undefined,
      "backup storage",
    ),
    prefix: environment.CLANK_BACKUP_PREFIX ?? "backups",
    chunkBytes,
    options: s3Options(
      environment,
      Math.max(32 * 1024 * 1024, chunkBytes),
      "backup storage",
    ),
  });
}

function s3Options(environment, maxObjectBytes, purpose) {
  const pathStyle = environment.CLANK_OBJECT_PATH_STYLE ?? "0";
  if (pathStyle !== "0" && pathStyle !== "1") {
    throw new Error("CLANK_OBJECT_PATH_STYLE must be 0 or 1.");
  }
  return Object.freeze({
    endpoint: required(environment, "CLANK_OBJECT_ENDPOINT", "AWS_ENDPOINT_URL", purpose),
    region: required(environment, "CLANK_OBJECT_REGION", "AWS_DEFAULT_REGION", purpose),
    bucket: required(environment, "CLANK_OBJECT_BUCKET", "AWS_S3_BUCKET_NAME", purpose),
    accessKeyId: required(environment, "CLANK_OBJECT_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", purpose),
    secretAccessKey: required(
      environment,
      "CLANK_OBJECT_SECRET_ACCESS_KEY",
      "AWS_SECRET_ACCESS_KEY",
      purpose,
    ),
    ...(environment.CLANK_OBJECT_SESSION_TOKEN || environment.AWS_SESSION_TOKEN
      ? {
          sessionToken: environment.CLANK_OBJECT_SESSION_TOKEN
            ?? environment.AWS_SESSION_TOKEN,
        }
      : {}),
    ...(environment.CLANK_OBJECT_PREFIX
      ? { prefix: environment.CLANK_OBJECT_PREFIX }
      : {}),
    pathStyle: pathStyle === "1",
    maxObjectBytes,
  });
}

function exactLabels(input) {
  const output = {};
  if (!input) return output;
  const entries = input.split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.length > 99) {
    throw new Error("CLANK_PROVIDER_LABELS cannot contain more than 99 labels.");
  }
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new Error("CLANK_PROVIDER_LABELS must use key=value entries.");
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (
      !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,99}$/u.test(key)
      || ["__proto__", "constructor", "prototype"].includes(key)
      || !value
      || value.length > 200
      || value.includes("\0")
    ) {
      throw new Error(`Invalid CLANK_PROVIDER_LABELS entry: ${key}`);
    }
    if (Object.hasOwn(output, key)) {
      throw new Error(`Duplicate CLANK_PROVIDER_LABELS entry: ${key}`);
    }
    output[key] = value;
  }
  return output;
}

function commaList(input) {
  if (!input) return [];
  return [...new Set(input.split(",").map((value) => value.trim()).filter(Boolean))];
}

function required(environment, primary, fallback, purpose) {
  const result = environment[primary] ?? (fallback ? environment[fallback] : undefined);
  if (!result) throw new Error(`${primary} is required for S3 ${purpose}.`);
  return result;
}

function value(environment, primary, legacy) {
  return environment[primary] ?? environment[legacy];
}

function positiveNumber(input, fallback) {
  if (input === undefined) return fallback;
  const parsed = Number(input);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment value: ${input}`);
  }
  return parsed;
}
