import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

/** The knowledge base folder: KB_DIR, or ../kb next to src/ or dist/. */
export const KB_DIR = process.env.KB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "kb");

const cache = new Map<string, unknown>();

export function kbText(rel: string): string {
  return readFileSync(join(KB_DIR, rel), "utf8");
}

export function kbYaml<T>(rel: string): T {
  if (!cache.has(rel)) cache.set(rel, YAML.parse(kbText(rel)));
  return cache.get(rel) as T;
}

/** Every markdown/yaml file in the knowledge base, relative paths. */
export function kbFiles(dir = ""): string[] {
  const abs = join(KB_DIR, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return kbFiles(rel);
    return /\.(md|ya?ml)$/.test(e.name) ? [rel] : [];
  });
}

export interface SourceEntry { id: string; name: string; url: string; access: string; checked: string; [k: string]: unknown }
export const sources = () => kbYaml<SourceEntry[]>("sources.yaml");
export function sourceRef(id: string): { id: string; name: string; url: string } {
  const s = sources().find((x) => x.id === id);
  return s ? { id, name: s.name, url: s.url } : { id, name: id, url: "" };
}
