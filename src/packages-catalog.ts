import catalogJson from "./packages-catalog.json";

export interface CatalogPackage {
	name: string;
	description: string;
	author: string;
	downloads: number;
	types: string[];
}

export const PACKAGES_CATALOG: CatalogPackage[] = catalogJson as CatalogPackage[];

export function formatDownloads(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
