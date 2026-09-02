import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./App.css";

type MediaKind = "video" | "audio";

const OUTPUT_FORMATS: Record<MediaKind, { value: string; label: string }[]> = {
  video: [
    { value: "mp4", label: "MP4" },
    { value: "mkv", label: "MKV" },
    { value: "mov", label: "MOV" },
    { value: "avi", label: "AVI" },
    { value: "webm", label: "WEBM" },
  ],
  audio: [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "flac", label: "FLAC" },
    { value: "aac", label: "AAC" },
    { value: "ogg", label: "OGG" },
  ],
};

const TAB_LABEL: Record<MediaKind, string> = {
  video: "Video",
  audio: "Audio",
};

type JobStatus = "pending" | "converting" | "done" | "error";

type Job = {
  id: string;
  kind: MediaKind;
  path: string;
  name: string;
  size: number | null;
  status: JobStatus;
  percent: number;
  outputPath?: string;
  error?: string;
  saved?: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function App() {
  const [activeTab, setActiveTab] = useState<MediaKind>("video");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [videoFormat, setVideoFormat] = useState<string>("mp4");
  const [audioFormat, setAudioFormat] = useState<string>("mp3");
  const [isDragActive, setIsDragActive] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const outputFormat = activeTab === "video" ? videoFormat : audioFormat;
  const setOutputFormat = activeTab === "video" ? setVideoFormat : setAudioFormat;

  useEffect(() => {
    const unlistenProgress = listen<{ id: string; percent: number }>(
      "conversion-progress",
      (event) => {
        const { id, percent } = event.payload;
        setJobs((prev) =>
          prev.map((j) => (j.id === id ? { ...j, percent } : j)),
        );
      },
    );

    const unlistenDrop = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setIsDragActive(true);
      } else if (event.payload.type === "leave") {
        setIsDragActive(false);
      } else if (event.payload.type === "drop") {
        setIsDragActive(false);
        void addFiles(event.payload.paths, activeTabRef.current);
      }
    });

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
    };
  }, []);

  async function addFiles(paths: string[], kind: MediaKind) {
    const existing = new Set(jobsRef.current.map((j) => j.path));
    for (const path of paths) {
      if (existing.has(path)) continue;
      try {
        const info = await invoke<{ name: string; size_bytes: number }>(
          "file_info",
          { path },
        );
        const job: Job = {
          id: crypto.randomUUID(),
          kind,
          path,
          name: info.name,
          size: info.size_bytes,
          status: "pending",
          percent: 0,
        };
        setJobs((prev) => [...prev, job]);
      } catch (err) {
        console.error("No se pudo leer el archivo", path, err);
      }
    }
  }

  async function pickFiles() {
    const selected = await open({
      multiple: true,
      title:
        activeTab === "video"
          ? "Elegir archivos de video"
          : "Elegir archivos de audio",
    });
    if (Array.isArray(selected)) {
      void addFiles(selected, activeTab);
    } else if (typeof selected === "string") {
      void addFiles([selected], activeTab);
    }
  }

  function removeJob(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }

  function clearTab() {
    setJobs((prev) => prev.filter((j) => j.kind !== activeTab));
  }

  async function handleConvertAll() {
    const pending = jobsRef.current.filter(
      (j) => j.status === "pending" && j.kind === activeTab,
    );
    if (pending.length === 0) return;
    setIsConverting(true);
    for (const job of pending) {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id ? { ...j, status: "converting", percent: 0 } : j,
        ),
      );
      try {
        const outputPath = await invoke<string>("convert_file", {
          jobId: job.id,
          inputPath: job.path,
          outputFormat,
        });
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? { ...j, status: "done", percent: 100, outputPath }
              : j,
          ),
        );
      } catch (err) {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? { ...j, status: "error", error: String(err) }
              : j,
          ),
        );
      }
    }
    setIsConverting(false);
  }

  async function downloadOne(job: Job) {
    if (!job.outputPath) return;
    const dest = await save({ defaultPath: fileNameOf(job.outputPath) });
    if (!dest) return;
    await invoke("copy_file", { source: job.outputPath, dest });
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, saved: true } : j)),
    );
  }

  function doneJobsForTab(): Job[] {
    return jobsRef.current.filter(
      (j) => j.status === "done" && j.outputPath && j.kind === activeTab,
    );
  }

  async function downloadAll() {
    const done = doneJobsForTab();
    if (done.length === 0) return;
    const folder = await open({
      directory: true,
      title: "Elegir carpeta de destino",
    });
    if (typeof folder !== "string") return;
    setIsExporting(true);
    try {
      const sources = done.map((j) => j.outputPath as string);
      await invoke<string[]>("copy_all", { sources, folder });
      const ids = new Set(done.map((j) => j.id));
      setJobs((prev) =>
        prev.map((j) => (ids.has(j.id) ? { ...j, saved: true } : j)),
      );
    } catch (err) {
      alert(`No se pudo guardar todo: ${err}`);
    } finally {
      setIsExporting(false);
    }
  }

  async function downloadZip() {
    const done = doneJobsForTab();
    if (done.length === 0) return;
    const dest = await save({
      defaultPath: `transformersp-${activeTab}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!dest) return;
    setIsExporting(true);
    try {
      const sources = done.map((j) => j.outputPath as string);
      await invoke<string>("create_zip", { sources, destZip: dest });
      const ids = new Set(done.map((j) => j.id));
      setJobs((prev) =>
        prev.map((j) => (ids.has(j.id) ? { ...j, saved: true } : j)),
      );
    } catch (err) {
      alert(`No se pudo crear el .zip: ${err}`);
    } finally {
      setIsExporting(false);
    }
  }

  const tabJobs = jobs.filter((j) => j.kind === activeTab);
  const pendingCount = tabJobs.filter((j) => j.status === "pending").length;
  const doneCount = tabJobs.filter((j) => j.status === "done").length;
  const videoCount = jobs.filter((j) => j.kind === "video").length;
  const audioCount = jobs.filter((j) => j.kind === "audio").length;

  return (
    <div className="app">
      <header className="app-header">
        <h1>TransformerSP</h1>
        <p>Convertí audio y video localmente, sin subir nada a internet.</p>
      </header>

      <div className="tabs">
        {(["video", "audio"] as MediaKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`tab ${activeTab === kind ? "tab-active" : ""}`}
            onClick={() => setActiveTab(kind)}
          >
            {TAB_LABEL[kind]}
            {(kind === "video" ? videoCount : audioCount) > 0 && (
              <span className="tab-count">
                {kind === "video" ? videoCount : audioCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <main className="app-main">
        <div
          className={`dropzone ${isDragActive ? "dropzone-active" : ""}`}
          onClick={pickFiles}
        >
          <div className="dropzone-placeholder">
            <span className="dropzone-icon">⇪</span>
            <span>
              Arrastrá uno o varios archivos de{" "}
              {activeTab === "video" ? "video" : "audio"} acá, o hacé click
              para elegirlos
            </span>
          </div>
        </div>

        {tabJobs.length > 0 && (
          <div className="job-list">
            {tabJobs.map((job) => (
              <div className="job-row" key={job.id}>
                <div className="job-info">
                  <span className="job-name">{job.name}</span>
                  {job.size !== null && (
                    <span className="job-size">{formatBytes(job.size)}</span>
                  )}
                </div>

                <div className="job-status">
                  {job.status === "pending" && (
                    <span className="badge badge-pending">Pendiente</span>
                  )}
                  {job.status === "converting" && (
                    <div className="progress-bar progress-bar-inline">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${job.percent.toFixed(1)}%` }}
                      />
                      <span className="progress-label">
                        {job.percent.toFixed(0)}%
                      </span>
                    </div>
                  )}
                  {job.status === "done" && (
                    <span className="badge badge-done">
                      {job.saved ? "Guardado" : "Listo"}
                    </span>
                  )}
                  {job.status === "error" && (
                    <span className="badge badge-error" title={job.error}>
                      Error
                    </span>
                  )}
                </div>

                <div className="job-actions">
                  {job.status === "done" && (
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => downloadOne(job)}
                    >
                      Descargar
                    </button>
                  )}
                  {job.status === "pending" && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => removeJob(job.id)}
                    >
                      Quitar
                    </button>
                  )}
                </div>

                {job.status === "error" && (
                  <div className="job-error">{job.error}</div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="controls">
          <div className="control-group">
            <label htmlFor="format">
              Formato de salida ({TAB_LABEL[activeTab].toLowerCase()})
            </label>
            <select
              id="format"
              value={outputFormat}
              onChange={(e) => setOutputFormat(e.target.value)}
            >
              {OUTPUT_FORMATS[activeTab].map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          {tabJobs.length > 0 && (
            <button type="button" className="link-button" onClick={clearTab}>
              Limpiar lista
            </button>
          )}
        </div>

        <button
          type="button"
          className="convert-button"
          disabled={pendingCount === 0 || isConverting}
          onClick={handleConvertAll}
        >
          {isConverting
            ? "Convirtiendo..."
            : `Convertir ${pendingCount > 0 ? `(${pendingCount})` : "todo"}`}
        </button>

        {doneCount > 0 && (
          <div className="export-bar">
            <span className="export-label">
              {doneCount} archivo{doneCount === 1 ? "" : "s"} listo
              {doneCount === 1 ? "" : "s"}:
            </span>
            <button
              type="button"
              className="secondary"
              disabled={isExporting}
              onClick={downloadAll}
            >
              Descargar todos
            </button>
            <button
              type="button"
              className="secondary"
              disabled={isExporting}
              onClick={downloadZip}
            >
              Descargar todo (.zip)
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
