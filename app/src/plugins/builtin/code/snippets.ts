// Keywords and snippets for languages Monaco only colors, offered while no language server serves the file.
// Snippet bodies use Monaco's snippet syntax ($1, ${1:name}, $0 for where the caret ends).

export interface Snippet { label: string; detail: string; body: string }
export interface LanguageWords { keywords: string[]; snippets: Snippet[] }

const c = {
  keywords: ["auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float", "for",
    "goto", "if", "inline", "int", "long", "register", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef",
    "union", "unsigned", "void", "volatile", "while", "bool", "true", "false", "NULL", "#include", "#define", "#ifdef", "#ifndef", "#endif"],
  snippets: [
    { label: "main", detail: "main function", body: "int main(int argc, char *argv[]) {\n\t$0\n\treturn 0;\n}" },
    { label: "for", detail: "for loop", body: "for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}" },
    { label: "while", detail: "while loop", body: "while (${1:condition}) {\n\t$0\n}" },
    { label: "if", detail: "if statement", body: "if (${1:condition}) {\n\t$0\n}" },
    { label: "else", detail: "else block", body: "else {\n\t$0\n}" },
    { label: "switch", detail: "switch statement", body: "switch (${1:value}) {\ncase ${2:0}:\n\t$0\n\tbreak;\ndefault:\n\tbreak;\n}" },
    { label: "struct", detail: "struct type", body: "typedef struct ${1:Name} {\n\t$0\n} $1;" },
    { label: "include", detail: "#include <...>", body: "#include <${1:stdio.h}>" },
    { label: "printf", detail: "print a line", body: "printf(\"${1:%s}\\n\", $2);" },
  ],
};

export const languageWords: Record<string, LanguageWords> = {
  python: {
    keywords: ["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else",
      "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
      "try", "while", "with", "yield", "match", "case", "self", "print", "len", "range", "enumerate", "zip", "list", "dict", "set", "tuple",
      "str", "int", "float", "bool", "isinstance", "open", "super"],
    snippets: [
      { label: "def", detail: "function", body: "def ${1:name}(${2}):\n\t${0:pass}" },
      { label: "class", detail: "class", body: "class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${0:pass}" },
      { label: "if", detail: "if statement", body: "if ${1:condition}:\n\t${0:pass}" },
      { label: "for", detail: "for loop", body: "for ${1:item} in ${2:items}:\n\t${0:pass}" },
      { label: "while", detail: "while loop", body: "while ${1:condition}:\n\t${0:pass}" },
      { label: "try", detail: "try / except", body: "try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:e}:\n\t${0:raise}" },
      { label: "with", detail: "with statement", body: "with ${1:open(path)} as ${2:f}:\n\t${0:pass}" },
      { label: "main", detail: "if __name__ == \"__main__\"", body: "if __name__ == \"__main__\":\n\t${0:main()}" },
      { label: "lambda", detail: "lambda", body: "lambda ${1:x}: ${0:x}" },
    ],
  },
  rust: {
    keywords: ["as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if",
      "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super",
      "trait", "true", "type", "unsafe", "use", "where", "while", "Some", "None", "Ok", "Err", "Option", "Result", "String", "Vec", "Box",
      "println!", "format!", "vec!", "panic!"],
    snippets: [
      { label: "fn", detail: "function", body: "fn ${1:name}(${2}) {\n\t$0\n}" },
      { label: "main", detail: "main function", body: "fn main() {\n\t$0\n}" },
      { label: "struct", detail: "struct", body: "struct ${1:Name} {\n\t${2:field}: ${3:i32},\n}" },
      { label: "enum", detail: "enum", body: "enum ${1:Name} {\n\t${0:Variant},\n}" },
      { label: "impl", detail: "impl block", body: "impl ${1:Type} {\n\t$0\n}" },
      { label: "match", detail: "match", body: "match ${1:value} {\n\t${2:pattern} => ${3:()},\n\t_ => ${0:()},\n}" },
      { label: "if let", detail: "if let", body: "if let Some(${1:x}) = ${2:option} {\n\t$0\n}" },
      { label: "for", detail: "for loop", body: "for ${1:item} in ${2:items} {\n\t$0\n}" },
      { label: "test", detail: "test function", body: "#[test]\nfn ${1:name}() {\n\t$0\n}" },
      { label: "println", detail: "println!", body: "println!(\"${1:{\\}}\", $2);" },
    ],
  },
  go: {
    keywords: ["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if",
      "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var", "nil", "true", "false",
      "string", "int", "int64", "float64", "bool", "byte", "rune", "error", "make", "len", "cap", "append", "new", "panic", "fmt.Println"],
    snippets: [
      { label: "func", detail: "function", body: "func ${1:name}(${2}) ${3:error} {\n\t$0\n}" },
      { label: "main", detail: "package main", body: "package main\n\nimport \"fmt\"\n\nfunc main() {\n\t${0:fmt.Println(\"hello\")}\n}" },
      { label: "if err", detail: "error check", body: "if err != nil {\n\treturn ${0:err}\n}" },
      { label: "for range", detail: "range loop", body: "for ${1:i}, ${2:v} := range ${3:items} {\n\t$0\n}" },
      { label: "for", detail: "for loop", body: "for ${1:i} := 0; $1 < ${2:n}; $1++ {\n\t$0\n}" },
      { label: "struct", detail: "struct type", body: "type ${1:Name} struct {\n\t$0\n}" },
      { label: "interface", detail: "interface type", body: "type ${1:Name} interface {\n\t$0\n}" },
      { label: "switch", detail: "switch", body: "switch ${1:value} {\ncase ${2:x}:\n\t$0\ndefault:\n}" },
      { label: "go func", detail: "goroutine", body: "go func() {\n\t$0\n}()" },
    ],
  },
  c,
  cpp: {
    keywords: [...c.keywords, "class", "namespace", "template", "typename", "public", "private", "protected", "virtual", "override",
      "new", "delete", "this", "nullptr", "using", "std::", "std::string", "std::vector", "std::cout", "std::endl", "constexpr", "noexcept"],
    snippets: [
      ...c.snippets.filter((s) => s.label !== "printf"),
      { label: "class", detail: "class", body: "class ${1:Name} {\npublic:\n\t$1();\n\t$0\n};" },
      { label: "for range", detail: "range-based for", body: "for (const auto& ${1:item} : ${2:items}) {\n\t$0\n}" },
      { label: "cout", detail: "print a line", body: "std::cout << ${1} << std::endl;" },
      { label: "namespace", detail: "namespace", body: "namespace ${1:name} {\n$0\n}" },
    ],
  },
  java: {
    keywords: ["abstract", "boolean", "break", "byte", "case", "catch", "char", "class", "continue", "default", "do", "double", "else",
      "enum", "extends", "final", "finally", "float", "for", "if", "implements", "import", "instanceof", "int", "interface", "long", "new",
      "package", "private", "protected", "public", "return", "static", "super", "switch", "this", "throw", "throws", "try", "void",
      "while", "var", "record", "null", "true", "false", "String", "System.out.println"],
    snippets: [
      { label: "main", detail: "main method", body: "public static void main(String[] args) {\n\t$0\n}" },
      { label: "class", detail: "class", body: "public class ${1:Name} {\n\t$0\n}" },
      { label: "for", detail: "for loop", body: "for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}" },
      { label: "foreach", detail: "for-each loop", body: "for (${1:var} ${2:item} : ${3:items}) {\n\t$0\n}" },
      { label: "if", detail: "if statement", body: "if (${1:condition}) {\n\t$0\n}" },
      { label: "try", detail: "try / catch", body: "try {\n\t$1\n} catch (${2:Exception} ${3:e}) {\n\t$0\n}" },
      { label: "sout", detail: "System.out.println", body: "System.out.println($0);" },
    ],
  },
  csharp: {
    keywords: ["abstract", "as", "async", "await", "base", "bool", "break", "case", "catch", "class", "const", "continue", "default",
      "do", "double", "else", "enum", "false", "finally", "float", "for", "foreach", "if", "in", "int", "interface", "internal", "is",
      "namespace", "new", "null", "object", "out", "override", "private", "protected", "public", "readonly", "record", "ref", "return",
      "static", "string", "struct", "switch", "this", "throw", "true", "try", "using", "var", "virtual", "void", "while", "Console.WriteLine"],
    snippets: [
      { label: "class", detail: "class", body: "public class ${1:Name}\n{\n\t$0\n}" },
      { label: "main", detail: "Main method", body: "static void Main(string[] args)\n{\n\t$0\n}" },
      { label: "prop", detail: "property", body: "public ${1:int} ${2:Name} { get; set; }" },
      { label: "foreach", detail: "foreach loop", body: "foreach (var ${1:item} in ${2:items})\n{\n\t$0\n}" },
      { label: "for", detail: "for loop", body: "for (int ${1:i} = 0; $1 < ${2:n}; $1++)\n{\n\t$0\n}" },
      { label: "if", detail: "if statement", body: "if (${1:condition})\n{\n\t$0\n}" },
      { label: "try", detail: "try / catch", body: "try\n{\n\t$1\n}\ncatch (${2:Exception} ${3:e})\n{\n\t$0\n}" },
      { label: "cw", detail: "Console.WriteLine", body: "Console.WriteLine($0);" },
    ],
  },
  shell: {
    keywords: ["if", "then", "elif", "else", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "return",
      "local", "export", "readonly", "echo", "printf", "read", "exit", "shift", "set", "unset", "source", "test", "true", "false"],
    snippets: [
      { label: "shebang", detail: "#!/usr/bin/env bash", body: "#!/usr/bin/env bash\nset -euo pipefail\n\n$0" },
      { label: "if", detail: "if statement", body: "if [[ ${1:condition} ]]; then\n\t$0\nfi" },
      { label: "for", detail: "for loop", body: "for ${1:item} in ${2:\"$@\"}; do\n\t$0\ndone" },
      { label: "while", detail: "while loop", body: "while ${1:condition}; do\n\t$0\ndone" },
      { label: "case", detail: "case statement", body: "case \"${1:\\$value}\" in\n\t${2:pattern}) $0 ;;\n\t*) ;;\nesac" },
      { label: "function", detail: "function", body: "${1:name}() {\n\t$0\n}" },
    ],
  },
  sql: {
    keywords: ["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE",
      "DROP", "ALTER", "INDEX", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET",
      "AS", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "NULL", "IS", "IN", "LIKE", "BETWEEN", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES"],
    snippets: [
      { label: "select", detail: "SELECT ... FROM", body: "SELECT ${1:*}\nFROM ${2:table}\nWHERE ${0:condition};" },
      { label: "insert", detail: "INSERT INTO", body: "INSERT INTO ${1:table} (${2:columns})\nVALUES (${0:values});" },
      { label: "update", detail: "UPDATE ... SET", body: "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${0:condition};" },
      { label: "create table", detail: "CREATE TABLE", body: "CREATE TABLE ${1:name} (\n\tid INTEGER PRIMARY KEY,\n\t$0\n);" },
    ],
  },
};
