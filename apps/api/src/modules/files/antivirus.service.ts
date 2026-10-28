import { Injectable, Logger } from '@nestjs/common';
import { Socket, createConnection } from 'node:net';
import { env } from '../../config/env';

export type ScanVerdict =
  | { status: 'CLEAN'; detail: string }
  | { status: 'INFECTED'; detail: string }
  | { status: 'SKIPPED'; detail: string };

/**
 * Analyse antivirus via clamd (protocole INSTREAM). En mode `disabled`, le statut
 * SKIPPED est explicite et visible : il n'est jamais présenté comme « sain ».
 */
@Injectable()
export class AntivirusService {
  private readonly logger = new Logger('Antivirus');

  get enabled(): boolean {
    return env().AV_MODE === 'clamav';
  }

  async scan(buffer: Buffer): Promise<ScanVerdict> {
    if (!this.enabled) return { status: 'SKIPPED', detail: 'Antivirus désactivé (AV_MODE=disabled)' };
    const reply = await this.instream(buffer);
    if (/:\s*OK$/.test(reply)) return { status: 'CLEAN', detail: 'clamd: OK' };
    const found = /:\s*(.+)\s+FOUND$/.exec(reply);
    if (found) return { status: 'INFECTED', detail: found[1].slice(0, 400) };
    throw new Error(`Réponse clamd inattendue : ${reply.slice(0, 200)}`);
  }

  private instream(buffer: Buffer): Promise<string> {
    const { CLAMAV_HOST, CLAMAV_PORT } = env();
    return new Promise((resolve, reject) => {
      const socket: Socket = createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
      const chunks: Buffer[] = [];
      socket.setTimeout(120_000);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Timeout clamd'));
      });
      socket.on('error', reject);
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < buffer.length; i += CHUNK) {
          const part = buffer.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // fin de flux
      });
    });
  }
}
