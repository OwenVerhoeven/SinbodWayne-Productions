import { fieldsForRecord, fieldValueForForm, type RecordFieldDefinition } from "./field-catalog";

export function RecordDetailFields({
  recordType,
  details,
}: {
  readonly recordType: string;
  readonly details: Readonly<Record<string, unknown>>;
}) {
  const fields = fieldsForRecord(recordType);
  if (fields.length === 0) return null;
  return (
    <fieldset className="record-detail-fields">
      <legend>Production details</legend>
      {fields.map((field) => (
        <DetailField details={details} field={field} key={field.key} />
      ))}
    </fieldset>
  );
}

function DetailField({
  field,
  details,
}: {
  readonly field: RecordFieldDefinition;
  readonly details: Readonly<Record<string, unknown>>;
}) {
  const name = `details.${field.key}`;
  const value = fieldValueForForm(field, details[field.key]);
  if (field.type === "checkbox") {
    return (
      <label className="choice-row record-detail-field">
        <input defaultChecked={details[field.key] === true} name={name} type="checkbox" />
        <span>{field.label}</span>
        {field.help ? <small>{field.help}</small> : null}
      </label>
    );
  }
  if (field.type === "textarea") {
    return (
      <label className="record-detail-field">
        <span>{field.label}</span>
        <textarea
          defaultValue={value}
          maxLength={8_000}
          name={name}
          required={field.required}
          rows={5}
        />
        {field.help ? <small>{field.help}</small> : null}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="record-detail-field">
        <span>{field.label}</span>
        <select defaultValue={value} name={name} required={field.required}>
          <option value="">Select…</option>
          {field.options?.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        {field.help ? <small>{field.help}</small> : null}
      </label>
    );
  }
  const inputType =
    field.type === "currency"
      ? "number"
      : field.type === "tags"
        ? "text"
        : field.type === "datetime"
          ? "datetime-local"
          : field.type;
  return (
    <label className="record-detail-field">
      <span>{field.label}</span>
      <input
        defaultValue={value}
        max={field.max}
        min={field.min}
        name={name}
        required={field.required}
        step={field.step}
        type={inputType}
      />
      {field.help ? <small>{field.help}</small> : null}
    </label>
  );
}
