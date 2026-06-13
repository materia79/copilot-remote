// Browser-side mirror of shared/question-schema.mjs field parsing.
// Kept in sync with the server helper so the relay UI renders multi-field
// `ask_user` / elicitation forms identically to how the server validates them.

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeChoice(entry) {
  if (typeof entry === 'string') {
    const value = entry.trim();
    return value ? { value, label: value } : null;
  }
  if (isPlainObject(entry)) {
    const value = entry.const !== undefined ? entry.const : (entry.value !== undefined ? entry.value : entry.title);
    if (value === undefined || value === null) return null;
    const label = String(entry.title || entry.label || entry.description || value).trim();
    return { value, label: label || String(value) };
  }
  return null;
}

function fieldChoices(prop) {
  const out = [];
  const pools = [prop?.enum, prop?.oneOf];
  if (isPlainObject(prop?.items)) {
    pools.push(prop.items.enum, prop.items.anyOf);
  }
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const entry of pool) {
      const choice = normalizeChoice(entry);
      if (choice) out.push(choice);
    }
  }
  const seen = new Set();
  return out.filter((choice) => {
    const key = String(choice.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function schemaFieldsFromQuestion(question) {
  const schema = question?.requestSchema;
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields = [];
  for (const [name, rawProp] of Object.entries(schema.properties)) {
    if (!isPlainObject(rawProp)) continue;
    const type = String(rawProp.type || 'string').toLowerCase();
    fields.push({
      name,
      type,
      title: String(rawProp.title || name).trim() || name,
      description: String(rawProp.description || '').trim(),
      required: requiredSet.has(name),
      hasDefault: Object.prototype.hasOwnProperty.call(rawProp, 'default'),
      default: rawProp.default,
      choices: fieldChoices(rawProp),
      isMultiSelect: type === 'array',
      format: String(rawProp.format || '').trim() || null,
    });
  }
  return fields;
}

export function isMultiFieldQuestion(question) {
  return schemaFieldsFromQuestion(question).length > 1;
}
