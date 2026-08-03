import type { RecordingSource } from "@/domain/models";

export function SourceChoice({
  recordingSupported,
  source,
  onChange,
}: {
  recordingSupported: boolean;
  source: RecordingSource;
  onChange: (source: RecordingSource) => void;
}) {
  return (
    <fieldset className="ingest-section ingest-source-choice">
      <legend className="field-label ingest-section__legend">Source</legend>
      <div className="ingest-source-choice__options">
        <label className="ingest-source-option interactive-target">
          <input
            checked={source === "upload"}
            name="source"
            onChange={() => onChange("upload")}
            type="radio"
            value="upload"
          />
          <span>
            <strong>Upload file</strong>
            <small>Send an existing audio or video file.</small>
          </span>
        </label>
        {recordingSupported ? (
          <label className="ingest-source-option interactive-target">
            <input
              checked={source === "record"}
              name="source"
              onChange={() => onChange("record")}
              type="radio"
              value="record"
            />
            <span>
              <strong>Record audio</strong>
              <small>Capture audio in this browser, then upload it.</small>
            </span>
          </label>
        ) : null}
      </div>
    </fieldset>
  );
}
