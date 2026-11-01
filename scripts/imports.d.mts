/** One module specifier in a source file, and the line it is on (1-based). */
export interface Import {
    specifier: string;
    line: number;
}

/** Every specifier a source text imports or re-exports: static and dynamic imports, `export ... from`, and `require`. */
export function importsOf(text: string): Import[];
