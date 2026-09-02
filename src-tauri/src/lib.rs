use regex::Regex;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Clone, serde::Serialize)]
struct ConversionProgress {
    id: String,
    percent: f64,
}

#[derive(Clone, serde::Serialize)]
struct FileInfo {
    name: String,
    size_bytes: u64,
}

#[tauri::command]
fn file_info(path: String) -> Result<FileInfo, String> {
    let p = Path::new(&path);
    let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("archivo")
        .to_string();
    Ok(FileInfo {
        name,
        size_bytes: metadata.len(),
    })
}

fn ffmpeg_args_for_format(fmt: &str) -> Result<Vec<&'static str>, String> {
    let args: Vec<&'static str> = match fmt {
        "mp4" | "mov" | "mkv" => vec![
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
        ],
        "avi" => vec![
            "-c:v", "mpeg4", "-qscale:v", "4", "-c:a", "libmp3lame", "-qscale:a", "4",
        ],
        "webm" => vec![
            "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-c:a", "libopus", "-b:a", "128k",
        ],
        "mp3" => vec!["-vn", "-c:a", "libmp3lame", "-b:a", "192k"],
        "wav" => vec!["-vn", "-c:a", "pcm_s16le"],
        "flac" => vec!["-vn", "-c:a", "flac"],
        "aac" => vec!["-vn", "-c:a", "aac", "-b:a", "192k"],
        "ogg" => vec!["-vn", "-c:a", "libvorbis", "-q:a", "5"],
        other => return Err(format!("Formato de salida no soportado todavia: {other}")),
    };
    Ok(args)
}

fn unique_path_in(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut counter = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({counter}).{ext}"));
        counter += 1;
    }
    candidate
}

fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .temp_dir()
        .map_err(|e| e.to_string())?
        .join("transformersp-output");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

async fn probe_duration_secs(app: &AppHandle, input_path: &str) -> Result<f64, String> {
    let sidecar = app.shell().sidecar("ffprobe").map_err(|e| e.to_string())?;
    let output = sidecar
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            input_path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout);
    text.trim()
        .parse::<f64>()
        .map_err(|_| "No se pudo determinar la duracion del archivo de entrada".to_string())
}

#[tauri::command]
async fn convert_file(
    app: AppHandle,
    job_id: String,
    input_path: String,
    output_format: String,
) -> Result<String, String> {
    let fmt = output_format.to_lowercase();
    let codec_args = ffmpeg_args_for_format(&fmt)?;

    let input = Path::new(&input_path);
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Nombre de archivo de entrada invalido")?;

    let out_dir = work_dir(&app)?;
    let output_path = unique_path_in(&out_dir, stem, &fmt);
    let output_path_str = output_path.to_string_lossy().to_string();

    let duration = probe_duration_secs(&app, &input_path).await.unwrap_or(0.0);

    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), input_path.clone()];
    args.extend(codec_args.iter().map(|s| s.to_string()));
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output_path_str.clone());

    let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;
    let (mut rx, _child) = sidecar.args(args).spawn().map_err(|e| e.to_string())?;

    let time_re_ms = Regex::new(r"out_time_ms=(\d+)").unwrap();
    let time_re_us = Regex::new(r"out_time_us=(\d+)").unwrap();
    let mut stderr_tail = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let line = String::from_utf8_lossy(&line);
                if duration > 0.0 {
                    let micros = time_re_us
                        .captures(&line)
                        .and_then(|c| c[1].parse::<f64>().ok())
                        .or_else(|| {
                            time_re_ms
                                .captures(&line)
                                .and_then(|c| c[1].parse::<f64>().ok())
                                .map(|ms| ms * 1000.0)
                        });
                    if let Some(us) = micros {
                        let percent = ((us / 1_000_000.0) / duration * 100.0).clamp(0.0, 100.0);
                        let _ = app.emit(
                            "conversion-progress",
                            ConversionProgress {
                                id: job_id.clone(),
                                percent,
                            },
                        );
                    }
                }
            }
            CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line);
                stderr_tail.push_str(&line);
                stderr_tail.push('\n');
                if stderr_tail.len() > 4000 {
                    let excess = stderr_tail.len() - 4000;
                    stderr_tail.drain(0..excess);
                }
            }
            CommandEvent::Terminated(payload) => {
                if payload.code == Some(0) {
                    let _ = app.emit(
                        "conversion-progress",
                        ConversionProgress {
                            id: job_id.clone(),
                            percent: 100.0,
                        },
                    );
                    return Ok(output_path_str);
                } else {
                    let tail: Vec<&str> = stderr_tail.lines().rev().take(6).collect();
                    let tail: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
                    return Err(format!("FFmpeg fallo:\n{tail}"));
                }
            }
            _ => {}
        }
    }

    Err("El proceso de conversion termino de forma inesperada".into())
}

#[tauri::command]
fn copy_file(source: String, dest: String) -> Result<(), String> {
    std::fs::copy(&source, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn copy_all(sources: Vec<String>, folder: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&folder);
    let mut results = Vec::with_capacity(sources.len());
    for source in sources {
        let src_path = Path::new(&source);
        let stem = src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("archivo");
        let ext = src_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("bin");
        let dest = unique_path_in(dir, stem, ext);
        std::fs::copy(&src_path, &dest).map_err(|e| e.to_string())?;
        results.push(dest.to_string_lossy().to_string());
    }
    Ok(results)
}

#[tauri::command]
fn create_zip(sources: Vec<String>, dest_zip: String) -> Result<String, String> {
    let file = std::fs::File::create(&dest_zip).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for source in sources {
        let src_path = Path::new(&source);
        let stem = src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("archivo")
            .to_string();
        let ext = src_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("bin")
            .to_string();

        let mut name = format!("{stem}.{ext}");
        let mut counter = 1;
        while used_names.contains(&name) {
            name = format!("{stem} ({counter}).{ext}");
            counter += 1;
        }
        used_names.insert(name.clone());

        zip.start_file(&name, options).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        std::fs::File::open(&src_path)
            .map_err(|e| e.to_string())?
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        zip.write_all(&buf).map_err(|e| e.to_string())?;
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(dest_zip)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            convert_file,
            file_info,
            copy_file,
            copy_all,
            create_zip
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
