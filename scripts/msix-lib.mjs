// Pure helpers for scripts/build-msix.mjs: the Microsoft Store (MSIX) package
// manifest and the values the Store validates in it.

// Used when the Partner Center values aren't supplied. A package built with
// these can be registered locally for testing but can't be submitted.
export const PLACEHOLDER_IDENTITY = {
  name: "TypeAloud.Dev",
  publisher: "CN=TypeAloud Dev",
  publisherDisplayName: "TypeAloud Dev",
};

// MSIX versions have four parts, and the Store reserves the last one: it must
// be 0 in a submitted package.
export function msixVersion(semver) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(semver).trim());
  if (!match) throw new Error(`Not a plain X.Y.Z version: ${semver}`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 65535)) throw new Error(`Version part above 65535: ${semver}`);
  if (parts[0] === 0) throw new Error(`The Store rejects a 0 major version: ${semver}`);
  return `${parts.join(".")}.0`;
}

export function validateIdentity({ name, publisher, publisherDisplayName }) {
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(name || "")) {
    throw new Error(`Identity name must be 3-50 letters, digits, "." or "-": ${name}`);
  }
  if (!/^(CN|L|O|OU|E|C|S|STREET|T|G|I|SN|DC|SERIALNUMBER)=/.test(publisher || "")) {
    throw new Error(`Publisher must be a distinguished name such as "CN=...": ${publisher}`);
  }
  if (!String(publisherDisplayName || "").trim()) {
    throw new Error("Publisher display name is empty");
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderManifest(template, values) {
  validateIdentity(values.identity);
  const fields = {
    IDENTITY_NAME: values.identity.name,
    PUBLISHER: values.identity.publisher,
    PUBLISHER_DISPLAY_NAME: values.identity.publisherDisplayName,
    VERSION: msixVersion(values.version),
    DISPLAY_NAME: values.displayName,
    DESCRIPTION: values.description,
    EXECUTABLE: values.executable,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
    if (!(key in fields)) throw new Error(`Unknown manifest placeholder: ${whole}`);
    return escapeXml(fields[key]);
  });
}

export function packageFileName(productName, version) {
  return `${productName}_${msixVersion(version)}_x64.msix`;
}
