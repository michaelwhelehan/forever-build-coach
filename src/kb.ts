import YAML from "yaml";
import { KB_FILES } from "./kb-bundle.js";

const parsed = new Map<string, unknown>();

export function kbText(rel: string): string {
  const text = KB_FILES[rel];
  if (text === undefined) throw new Error(`Knowledge base file not found: ${rel}`);
  return text;
}

export function kbYaml<T>(rel: string): T {
  if (!parsed.has(rel)) parsed.set(rel, YAML.parse(kbText(rel)));
  return parsed.get(rel) as T;
}

export const kbFiles = () => Object.keys(KB_FILES);

export interface SourceEntry { id: string; name: string; url: string; access: string; checked: string; [k: string]: unknown }
export const sources = () => kbYaml<SourceEntry[]>("sources.yaml");
export function sourceRef(id: string): { id: string; name: string; url: string } {
  const s = sources().find((x) => x.id === id);
  return s ? { id, name: s.name, url: s.url } : { id, name: id, url: "" };
}
