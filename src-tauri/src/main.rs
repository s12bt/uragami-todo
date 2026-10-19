#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

/// 設定ファイル（アプリの設定フォルダの config.json）。持つのはデータファイルの場所だけ
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Config {
    data_path: Option<String>,
}

fn home() -> Result<PathBuf, String> {
    std::env::var("HOME").map(PathBuf::from).map_err(|e| e.to_string())
}

fn expand_tilde(path: &str) -> Result<PathBuf, String> {
    match path.strip_prefix("~/") {
        Some(rest) => Ok(home()?.join(rest)),
        None => Ok(PathBuf::from(path)),
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

/// データファイルの場所。設定が無いときは ~/Documents/uragami-todo/todo.json
fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config: Config = match fs::read_to_string(config_path(app)?) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("config.json を読めません: {e}"))?,
        Err(_) => Config::default(),
    };
    match config.data_path {
        Some(p) if !p.trim().is_empty() => expand_tilde(p.trim()),
        _ => Ok(home()?.join("Documents/uragami-todo/todo.json")),
    }
}

fn mtime(path: &PathBuf) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_millis() as u64)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Loaded {
    content: Option<String>,
    mtime: Option<u64>,
    path: String,
    config_path: String,
}

/// ファイルの中身と更新時刻を返す。ファイルが無いときは content が None
#[tauri::command]
fn load_todo(app: AppHandle) -> Result<Loaded, String> {
    let path = data_path(&app)?;
    let content = if path.exists() {
        Some(fs::read_to_string(&path).map_err(|e| e.to_string())?)
    } else {
        None
    };
    Ok(Loaded {
        content,
        mtime: mtime(&path),
        path: path.display().to_string(),
        config_path: config_path(&app)?.display().to_string(),
    })
}

/// 読み込んだときから外で書き換わっていなければ保存する。
/// 書き換わっていたら "conflict" を返し、呼び出し側で読み直してもらう
#[tauri::command]
fn save_todo(app: AppHandle, content: String, expected_mtime: Option<u64>) -> Result<Option<u64>, String> {
    let path = data_path(&app)?;
    if mtime(&path) != expected_mtime {
        return Err("conflict".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // 書きかけのファイルを読まれないよう、一時ファイルに書いてから置き換える
    let tmp = path.with_file_name(".todo.json.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(mtime(&path))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_todo, save_todo])
        .run(tauri::generate_context!())
        .expect("アプリの起動に失敗しました");
}
