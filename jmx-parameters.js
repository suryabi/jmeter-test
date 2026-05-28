const fs = require("fs");

const BOOLEAN_PARAMS = new Set(["allowWeekends", "checkDuplicateCustomer"]);

const DATE_PARAMS = new Set([
  "requestStartDate",
  "requestEndDate",
  "duplicateCustomerFromDate",
  "duplicateCustomerToDate"
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function encodeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inferType(name) {
  if (BOOLEAN_PARAMS.has(name)) return "boolean";
  if (DATE_PARAMS.has(name)) return "date";
  return "text";
}

function sectionIdFromTestname(testname, fallbackIndex) {
  const slug = String(testname || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `group-${fallbackIndex + 1}`;
}

function parseArgumentsSections(xml) {
  const sections = [];
  const re =
    /<Arguments\b[^>]*testname="([^"]+)"[^>]*>[\s\S]*?<collectionProp name="Arguments\.arguments">([\s\S]*?)<\/collectionProp>[\s\S]*?<\/Arguments>/g;

  let match;
  while ((match = re.exec(xml)) !== null) {
    const testname = decodeXml(match[1] || "").trim();
    const blockXml = match[2] || "";
    sections.push({
      id: sectionIdFromTestname(testname, sections.length),
      title: testname || `Group ${sections.length + 1}`,
      parameters: parseArgumentsBlock(blockXml)
    });
  }

  return sections;
}

function parseArgumentsBlock(blockXml) {
  const params = [];
  const re = /<elementProp name="([^"]+)" elementType="Argument">([\s\S]*?)<\/elementProp>/g;

  let match;
  while ((match = re.exec(blockXml)) !== null) {
    const inner = match[2];
    const name =
      inner.match(/<stringProp name="Argument.name">([^<]*)<\/stringProp>/)?.[1] || match[1];
    const defaultValue = decodeXml(
      inner.match(/<stringProp name="Argument.value">([^<]*)<\/stringProp>/)?.[1] || ""
    );
    const description = decodeXml(
      inner.match(/<stringProp name="Argument.desc">([^<]*)<\/stringProp>/)?.[1] || ""
    );
    params.push({
      name,
      defaultValue,
      description,
      type: inferType(name),
      required: /REQUIRED/i.test(description)
    });
  }

  return params;
}

function parseJmxParameters(planPath) {
  const xml = fs.readFileSync(planPath, "utf-8");
  const groups = parseArgumentsSections(xml).filter((group) => group.parameters.length > 0);

  return { planPath, groups };
}

function setArgumentValue(xml, name, value) {
  const encoded = encodeXml(value);
  const re = new RegExp(
    `(<elementProp name="${escapeRegExp(name)}" elementType="Argument">\\s*<stringProp name="Argument.name">${escapeRegExp(name)}</stringProp>\\s*<stringProp name="Argument.value">)[^<]*(</stringProp>)`
  );

  if (!re.test(xml)) {
    return xml;
  }

  return xml.replace(re, `$1${encoded}$2`);
}

function applyParameterOverrides(planPath, overrides) {
  let xml = fs.readFileSync(planPath, "utf-8");

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    xml = setArgumentValue(xml, name, String(value));
  }

  return xml;
}

module.exports = {
  parseJmxParameters,
  applyParameterOverrides
};
