import { solidViewer } from "../plugins/solid";
import type { ClientPlugin } from "../plugins/types";
import ImageViewer from "./ImageViewer";
import MarkdownViewer from "./MarkdownViewer";
import { AudioViewer, VideoViewer } from "./MediaViewer";
import TextViewer from "./TextViewer";
import "./viewers.css";

export const codeExtensions = [
  "txt", "log", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm",
  "css", "scss", "js", "mjs", "cjs", "jsx", "ts", "tsx", "rs", "cs", "py", "go", "java", "kt", "swift", "c", "h", "cpp",
  "hpp", "cc", "m", "rb", "php", "lua", "gd", "gdshader", "glsl", "hlsl", "wgsl", "sh", "bash", "zsh", "ps1", "bat",
  "sql", "graphql", "proto", "dockerfile", "makefile", "cmake", "gradle", "vue", "svelte", "md", "markdown",
];

// Order matters within the plugin: the first match is the default, so markdown comes before code.
export const viewersPlugin: ClientPlugin = {
  manifest: {
    id: "makework.viewers",
    icon: "docs-preview",
    name: "File viewers",
    version: "1.0.0",
    description: "Images, video, audio, markdown, code and text.",
    author: "MakeWork",
    contributes: {
      viewers: [
        { id: "image", label: "Image", mimeTypes: ["image/*"], extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"] },
        { id: "video", label: "Video", mimeTypes: ["video/*"], extensions: ["mp4", "webm", "mov", "mkv", "ogv", "m4v"] },
        { id: "audio", label: "Audio", mimeTypes: ["audio/*"], extensions: ["mp3", "ogg", "oga", "wav", "flac", "m4a", "opus", "aac"] },
        { id: "markdown", label: "Markdown", mimeTypes: ["text/markdown", "text/x-markdown"], extensions: ["md", "markdown"] },
        {
          id: "text", label: "Text",
          mimeTypes: ["text/*", "application/json", "application/javascript", "application/xml", "application/x-sh", "application/toml", "application/yaml"],
          extensions: codeExtensions,
        },
      ],
    },
  },
  viewers: {
    image: solidViewer(ImageViewer),
    video: solidViewer(VideoViewer),
    audio: solidViewer(AudioViewer),
    markdown: solidViewer(MarkdownViewer),
    text: solidViewer(TextViewer),
  },
};
