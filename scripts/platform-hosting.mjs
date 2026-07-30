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

function value(environment, primary, legacy) {
  return environment[primary] ?? environment[legacy];
}
