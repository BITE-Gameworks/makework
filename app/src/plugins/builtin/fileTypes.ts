// The text and code file types the editor handles, for the new-file form (files and code channels).
export const fileTypes = [
  { ext: "txt", label: "Plain text" }, { ext: "md", label: "Markdown" }, { ext: "json", label: "JSON" },
  { ext: "ts", label: "TypeScript" }, { ext: "tsx", label: "TypeScript JSX" }, { ext: "js", label: "JavaScript" }, { ext: "jsx", label: "JavaScript JSX" },
  { ext: "html", label: "HTML" }, { ext: "css", label: "CSS" }, { ext: "scss", label: "SCSS" },
  { ext: "py", label: "Python" }, { ext: "cs", label: "C#" }, { ext: "rs", label: "Rust" }, { ext: "go", label: "Go" },
  { ext: "java", label: "Java" }, { ext: "kt", label: "Kotlin" }, { ext: "c", label: "C" }, { ext: "cpp", label: "C++" }, { ext: "h", label: "C/C++ header" },
  { ext: "lua", label: "Lua" }, { ext: "gd", label: "GDScript" }, { ext: "glsl", label: "GLSL shader" },
  { ext: "sh", label: "Shell script" }, { ext: "sql", label: "SQL" }, { ext: "yaml", label: "YAML" }, { ext: "toml", label: "TOML" },
  { ext: "xml", label: "XML" }, { ext: "csv", label: "CSV" },
] as const;

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

// "notes" + md -> "notes.md"; a name that already ends in a known type keeps it.
export const withType = (name: string, ext: string) => {
  const typed = name.trim();
  return fileTypes.some((type) => type.ext === extensionOf(typed)) ? typed : `${typed}.${ext}`;
};
