import { useState, type ChangeEvent } from "react";

import { fieldsForRecord, fieldValueForForm, type RecordFieldDefinition } from "./field-catalog";
import { promptForField, workflowForRecord } from "./workflow-catalog";

export function RecordDetailFields({
  recordType,
  details,
}: {
  readonly recordType: string;
  readonly details: Readonly<Record<string, unknown>>;
}) {
  const fields = fieldsForRecord(recordType);
  const workflow = workflowForRecord(recordType);
  const [answered, setAnswered] = useState(
    () =>
      new Set(fields.filter((field) => hasAnswer(details[field.key])).map((field) => field.key)),
  );
  const [openSections, setOpenSections] = useState(
    () =>
      new Set(
        workflow.groups
          .filter(
            (section, index) =>
              index === 0 || section.fieldKeys.some((fieldKey) => hasAnswer(details[fieldKey])),
          )
          .map((section) => section.key),
      ),
  );
  if (fields.length === 0) return null;

  function answerChanged(field: RecordFieldDefinition, value: string | boolean) {
    setAnswered((current) => {
      const next = new Set(current);
      if (typeof value === "boolean" ? value : value.trim()) next.add(field.key);
      else next.delete(field.key);
      return next;
    });
  }

  return (
    <fieldset className="record-detail-fields">
      <legend>Guided planning questions</legend>
      <div className="record-workflow-progress">
        <div>
          <strong>
            {answered.size} of {fields.length} planning prompts answered
          </strong>
          <span>Answer what is known now. Unanswered prompts remain visible after saving.</span>
        </div>
        <progress aria-label="Planning prompt progress" max={fields.length} value={answered.size} />
      </div>
      <div className="record-workflow-sections">
        {workflow.groups.map((section, index) => {
          const sectionFields = section.fieldKeys
            .map((key) => fields.find((field) => field.key === key))
            .filter((field): field is RecordFieldDefinition => Boolean(field));
          const completed = sectionFields.filter((field) => answered.has(field.key)).length;
          return (
            <details
              className="record-workflow-section"
              key={section.key}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpenSections((current) => {
                  const next = new Set(current);
                  if (isOpen) next.add(section.key);
                  else next.delete(section.key);
                  return next;
                });
              }}
              open={openSections.has(section.key)}
            >
              <summary>
                <span className="record-workflow-section__number">{index + 1}</span>
                <span>
                  <strong>{section.title}</strong>
                  <small>{section.description}</small>
                </span>
                <span className="record-workflow-section__count">
                  {completed}/{sectionFields.length}
                </span>
              </summary>
              <div className="record-workflow-section__fields">
                {sectionFields.map((field) => (
                  <DetailField
                    details={details}
                    field={field}
                    key={field.key}
                    onAnsweredChange={(value) => answerChanged(field, value)}
                    prompt={promptForField(recordType, field)}
                  />
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </fieldset>
  );
}

function DetailField({
  field,
  details,
  onAnsweredChange,
  prompt,
}: {
  readonly field: RecordFieldDefinition;
  readonly details: Readonly<Record<string, unknown>>;
  readonly onAnsweredChange: (value: string | boolean) => void;
  readonly prompt: string;
}) {
  const name = `details.${field.key}`;
  const value = fieldValueForForm(field, details[field.key]);
  if (field.type === "checkbox") {
    return (
      <label className="choice-row record-detail-field">
        <input
          defaultChecked={details[field.key] === true}
          name={name}
          onChange={(event) => onAnsweredChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>{prompt}</span>
        <FieldHelp field={field} />
      </label>
    );
  }
  if (field.type === "textarea") {
    return (
      <label className="record-detail-field">
        <span>{prompt}</span>
        <textarea
          defaultValue={value}
          maxLength={8_000}
          name={name}
          onChange={(event) => onAnsweredChange(event.currentTarget.value)}
          placeholder="Add the useful production answer here. You can refine it later."
          required={field.required}
          rows={5}
        />
        <FieldHelp field={field} />
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="record-detail-field">
        <span>{prompt}</span>
        <select
          defaultValue={value}
          name={name}
          onChange={(event) => onAnsweredChange(event.currentTarget.value)}
          required={field.required}
        >
          <option value="">Select…</option>
          {field.options?.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <FieldHelp field={field} />
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
      <span>{prompt}</span>
      <input
        defaultValue={value}
        max={field.max}
        min={field.min}
        name={name}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onAnsweredChange(event.currentTarget.value)
        }
        placeholder={placeholderFor(field)}
        required={field.required}
        step={field.step}
        type={inputType}
      />
      <FieldHelp field={field} />
    </label>
  );
}

function FieldHelp({ field }: { readonly field: RecordFieldDefinition }) {
  return (
    <small>
      {field.required ? "Needed before approval." : "Optional for now."}
      {field.help ? ` ${field.help}` : ""}
    </small>
  );
}

function hasAnswer(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function placeholderFor(field: RecordFieldDefinition): string | undefined {
  if (field.type === "tags") return "Add short terms separated by commas";
  if (field.type === "url") return "https://";
  if (field.type === "email") return "name@example.com";
  if (field.type === "tel") return "+31";
  if (field.type === "text") return "Add a concise working answer";
  return undefined;
}
