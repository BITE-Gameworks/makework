// Where the node itself is, for the globe: the country of its public address, from DB-IP's free country database (CC
// BY 4.0, credited on the globe; 4 MB download, 8 MB on disk), shown at a point for that country (countryPlaces.ts).
// Downloaded into <data>/geoip once a month; read at start and let go after.
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { open, type CountryResponse, type Reader } from "maxmind";
import type { Place } from "../p2p/nodes";
import { countryPlaces } from "./countryPlaces";

export type GeoMode = "country" | "off";

const monthMs = 30 * 24 * 3_600_000;

export class GeoIp {
  private reader: Promise<Reader<CountryResponse> | null> | null = null;
  private readonly file: string;

  constructor(private readonly dir: string, private readonly mode: GeoMode) {
    this.file = join(dir, "geoip", "dbip-country-lite.mmdb");
  }

  // Fetches the database if it is missing or a month old; quietly gives up when offline.
  async update(): Promise<void> {
    // The city database earlier versions used.
    await rm(join(this.dir, "geoip", "dbip-city-lite.mmdb"), { force: true });
    if (this.mode === "off") return;
    const age = await stat(this.file).then((s) => Date.now() - s.mtimeMs, () => Infinity);
    if (age < monthMs) return;
    const now = new Date();
    for (const back of [0, 1]) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
      const response = await fetch(`https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`).catch(() => null);
      if (!response?.ok || !response.body) continue;
      await mkdir(join(this.dir, "geoip"), { recursive: true });
      const temp = `${this.file}.download`;
      try {
        await pipeline(Readable.fromWeb(response.body as never), createGunzip(), createWriteStream(temp));
        await rename(temp, this.file);
        this.reader = null;
        console.info(`GeoIP database updated (DB-IP ${month}).`);
      } catch (e) {
        await rm(temp, { force: true });
        console.warn("GeoIP database not downloaded:", (e as Error).message);
      }
      return;
    }
    console.warn("GeoIP database not available; members' locations can't be shown.");
  }

  // Frees the database's memory until the next lookup.
  release(): void {
    this.reader = null;
  }

  async lookup(address: string | null | undefined): Promise<Place | null> {
    if (this.mode === "off" || !address || !isIP(address) || isPrivate(address)) return null;
    this.reader ??= open<CountryResponse>(this.file).catch(() => null);
    const result = (await this.reader)?.get(address);
    const country = result?.country;
    const point = country ? countryPlaces[country.iso_code] : undefined;
    if (!point) return null;
    return { lat: point[0], lon: point[1], city: "", country: country!.names.en ?? "" };
  }
}

// Addresses on a local network, which say nothing about where someone is.
export function isPrivate(address: string): boolean {
  if (address.includes(":")) return /^(::1$|f[cd]|fe80)/i.test(address);
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
}
