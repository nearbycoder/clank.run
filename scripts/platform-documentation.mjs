/** Load the immutable, first-party documentation bundle only when explicitly enabled. */
export async function loadBundledDocumentation(
  environment,
  publicUrl,
  load = () => import("../docs-site/dist/server.js"),
) {
  const configuredHost = environment.CLANK_DOCUMENTATION_HOST;
  if (configuredHost === undefined) return null;
  const hostname = documentationHostname(configuredHost);
  if (hostname === new URL(publicUrl).hostname.toLowerCase()) {
    throw new Error("CLANK_DOCUMENTATION_HOST must differ from the platform public URL hostname.");
  }
  // Import before opening platform state. Missing bundle files must fail startup,
  // rather than silently serving the previous tenant release at this hostname.
  const module = await load();
  if (typeof module?.app?.handle !== "function") {
    throw new Error("The bundled documentation module must export an app with a handle function.");
  }
  return Object.freeze({ hostname, app: module.app });
}

export function routeBundledDocumentation(platform, documentation) {
  if (!documentation) return platform;
  return {
    handle(request) {
      const hostname = new URL(request.url).hostname.toLowerCase();
      const host = request.headers.get("host");
      // The HTTP adapter may trust a proxy when constructing Request.url. Require
      // agreement with the actual Host header; forwarded headers never select docs.
      const rawHostname = host === null ? hostname : requestHostname(host);
      return hostname === documentation.hostname && rawHostname === documentation.hostname
        ? documentation.app.handle(request)
        : platform.handle(request);
    },
  };
}

function documentationHostname(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253
    || !value.split(".").every((label) => (
      label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
    ))) {
    throw new Error("CLANK_DOCUMENTATION_HOST must be one exact hostname, without a URL, port, path, wildcard, or list.");
  }
  return value.toLowerCase();
}

function requestHostname(host) {
  const match = /^([^:]+)(?::([0-9]{1,5}))?$/u.exec(host);
  if (!match || (match[2] !== undefined && Number(match[2]) > 65535)) return null;
  try {
    return documentationHostname(match[1]);
  } catch {
    return null;
  }
}
