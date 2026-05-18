import { PathLike } from "fs";

import { Cite, CiteEntry, plugins } from "@citation-js/core";
import context from "../../compat/utils";
import { get_locales, get_styles } from "../../compat/data";

const citation_template_pattern = /^(.+?)\$id(.+)$/;
const macro_template_pattern =
  /(?<macro>bibitem|cite|citenp):(?<pretext>[^[\s]*)\[(?<key>[^\]]+)\]/g;
const latex_output_specifier = ["latex", "bibtex", "biblatex"];
const citation_item_pattern = /^(?<bib_key>[^()]+)(?<paragraph>\([^)]*\))?$/;

/**
 * Get a string to use as comparison reference for a citation
 * @param e The internal {@link Cite} representation of a single bibliography entry
 * @returns A string that may be used to compare the entry to others
 */
function get_cmp_string(e: CiteEntry): string {
  if (!e) {
    return "";
  }
  let acc = "";
  if (e.author) {
    acc += e.author.map((e) => e.family).join("||");
  } else if (e.editor) {
    acc += e.editor;
  }
  if (e.issued && e.issued["date-parts"]) {
    e.issued["date-parts"].forEach((e) => {
      let es = e.toString();
      while (es.length < 4) es = `0${es}`;
      acc += `||${es}`;
    });
  }
  return acc;
}

/**
 * Class used through utility method to hold data about citations for
 * current document, and run the different steps to add the citations
 * and bibliography
 */
class TreeProcessor {
  biblio: Record<string, CiteEntry>;
  links: boolean;
  style: string;
  locale: string;
  numeric_in_appearance_order: boolean;
  output: string;
  throw_on_unknown: boolean;
  bibtex_ob: string;
  bibtex_cb: string;
  citations: string[];
  filenames: Set<string>;

  constructor(
    bibfile: PathLike,
    links = false,
    style = "ieee",
    locale = "en-US",
    numeric_in_appearance_order = false,
    output = "asciidoc",
    throw_on_unknown = false,
    custom_citation_template = "[$id]",
  ) {
    if (!context.fs.existsSync(bibfile)) {
      throw `File '${bibfile}' is not found`;
    }
    const bibtex = context.fs.readFileSync(bibfile, { encoding: "utf8" });

    this.biblio = (
      new Cite(bibtex) as unknown as { data: CiteEntry[] }
    ).data.reduce(
      (p, e) => {
        if (e["id"] in p) {
          console.warn(
            `Bibliography entry with ID ${e["id"]} is present more than once, only the last entry found will be used.`,
          );
        }
        p[e["id"]] = e;
        return p;
      },
      {} as Record<string, CiteEntry>,
    );
    this.links = links;
    this.style = style;
    this.locale = locale;
    this.numeric_in_appearance_order = numeric_in_appearance_order;
    this.output = output;
    this.throw_on_unknown = throw_on_unknown;
    const match = citation_template_pattern.exec(custom_citation_template);
    if (match) {
      this.bibtex_ob = match[1];
      this.bibtex_cb = match[2];
    } else {
      this.bibtex_ob = "[";
      this.bibtex_cb = "]";
    }
    this.citations = [];
    this.filenames = new Set();
    this.register_csl_requirements(this.style, this.locale);
  }

  reorder_bibliography() {
    // TODO: add reverse order option, just because we can
    if (this.numeric_in_appearance_order) return;
    const sort_index: Record<string, string> = {};
    this.citations.sort((a, b) => {
      if (!(a in sort_index)) {
        sort_index[a] = get_cmp_string(this.biblio[a]) || a;
      }
      if (!(b in sort_index)) {
        sort_index[b] = get_cmp_string(this.biblio[b]) || b;
      }
      return (
        Number(sort_index[a] > sort_index[b]) -
        Number(sort_index[a] < sort_index[b])
      );
    });
  }

  register_csl_requirements(style?: string, locale?: string) {
    const csl_config = plugins.config.get("@csl");
    const style_collection = get_styles();
    if (style_collection && style) {
      let template = style_collection[style];
      if (template && template.short_parent) {
        // Manually resolve dependent styles to their parent style
        template = style_collection[template.short_parent];
      }
      if (template && template.content) {
        csl_config.templates.add(style, template.content);
      }
    }
    const locale_collection = get_locales();
    if (locale_collection && locale) {
      const locale_string = locale_collection.mappings[locale] || locale;
      if (locale in locale_collection.locales) {
        csl_config.locales.add(
          locale,
          locale_collection.locales[locale_string],
        );
      }
    }
  }

  build_bibliography_list(): string[] {
    const cite = new Cite();
    cite.options({ style: "csl" });
    this.citations.forEach((c) => {
      if (c in this.biblio) {
        cite.add(this.biblio[c]);
      } else {
        cite.add({
          id: c,
          title: c,
        });
      }
    });
    const entries = cite
      .format("bibliography", {
        template: this.style,
        lang: this.locale,
        asEntryArray: true,
        nosort: true,
      })
      .map((e: [string, string]) => e[1]);
    return entries;
  }

  process_inline_bibitem(pretext: string, key: string): string {
    key = key.trim();
    let result;
    if (key in this.biblio) {
      // TODO: Use citeproc here to generate bibitem
      const cite = new Cite().set(this.biblio[key]);
      cite.options({ style: "csl" });
      const entry = cite
        .format("bibliography", { template: this.style, lang: this.locale })
        .trim();
      result = `${entry}`;
    } else {
      console.error(`Unknown bibliography reference: ${key}`);
      result = key;
    }
    return result;
  }

  process_inline_cite(pretext: string, key: string, is_np: boolean): string {
    const items = key
      .split(",")
      .map((s) => s.trim())
      .map((s) => citation_item_pattern.exec(s))
      .filter((s) => s) as RegExpExecArray[];

    if (latex_output_specifier.includes(this.output)) {
      // xelatex does not support "\citenp", so we output all references as "cite" here unless we're using biblatex.
      const latex_command =
        this.output == "biblatex" ? (is_np ? "textcite" : "parencite") : "cite";
      const result = items
        .map((i) => {
          const bib_key = i[1];
          const paragraph = i[2];
          if (!this.citations.includes(bib_key)) {
            this.citations.push(bib_key);
          }
          let v = `\\${latex_command}`;
          if (paragraph) v += `[p.${paragraph}]`;
          return `${v}{bibliography_entry_${bib_key}}`;
        })
        .join(",");
      return `+++${result}+++`;
    } else {
      // TODO: Handle Style and type variants, see ruby implementation with Styleutils
      // Default values are for citenp
      const separator = ";";
      const result = items
        .map((i) => {
          const bib_key = i[1];

          let v;
          if (!this.citations.includes(bib_key)) {
            this.citations.push(bib_key);
          }
          if (bib_key in this.biblio) {
            const cite = new Cite().set(this.biblio[bib_key]);
            cite.options({ style: "csl" });
            const formatted = cite.format("citation", {
              template: this.style,
              lang: this.locale
            });
            v = formatted || `[${this.citations.indexOf(bib_key) + 1}]`;
          } else {
            const error_message = `Unknown bibliography reference: ${bib_key}`;
            if (this.throw_on_unknown) {
              throw error_message;
            } else {
              console.error(error_message);
              v = `[${bib_key}]`;
            }
          }
          // TODO: perform HTML to asciidoc escape on v
          if (this.links) return `<<bibliography_entry_${bib_key},${v}>>`;
          else return v;
        })
        .join(`${separator} `);
      // TODO: Handle Style and type variants, see ruby implementation with Styleutils
      // TODO: implement include_pretext
      return `[.citation]#${result}#`;
    }
  }

  /**
   * Scan a line and process citation macros.
   *
   * As this function being called iteratively on the lines of the document,
   * processor will build a list of all citation keys in the same order as they
   * appear in the original document.
   * @param line
   */
  process_inline_macros(line: string): string {
    // TODO
    return line.replace(
      macro_template_pattern,
      (full: string, macro: string, pretext: string, key: string) => {
        if (macro === "bibitem") {
          return this.process_inline_bibitem(pretext, key);
        } else {
          // cite/citenp
          return this.process_inline_cite(pretext, key, macro == "citenp");
        }
      },
    );
  }

  search_and_flag_inline_macros(line: string): boolean {
    let found_macros = false;
    line.replace(
      macro_template_pattern,
      (full: string, macro: string, pretext: string, key: string) => {
        found_macros = true;
        if (macro !== "bibitem") {
          // cite/citenp
          const items = key
            .split(",")
            .map((s) => s.trim())
            .map((s) => citation_item_pattern.exec(s))
            .filter((s) => s) as RegExpExecArray[];
          items.map((i) => {
            const bib_key = i[1];
            if (!this.citations.includes(bib_key)) {
              this.citations.push(bib_key);
            }
          });
        }
        return "";
      },
    );
    return found_macros;
  }
}

export { TreeProcessor };
