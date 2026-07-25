import { Injectable } from '@nestjs/common';
import { FileSourceProvider, ProviderDescriptor } from './file-source-provider.types';
import { SharePointProvider } from './providers/sharepoint.provider';
import { GoogleDriveProvider } from './providers/google-drive.provider';

/**
 * Registry des sources de fichiers. Keyée par `source`. Ajouter une source =
 * injecter sa classe ici (et l'ajouter aux providers du module). L'UI admin lit
 * `list()` pour proposer les types disponibles.
 */
@Injectable()
export class FileSourceProviderRegistry {
  private readonly map = new Map<string, FileSourceProvider>();

  constructor(sharepoint: SharePointProvider, googleDrive: GoogleDriveProvider) {
    this.register(sharepoint);
    this.register(googleDrive);
  }

  private register(p: FileSourceProvider): void {
    this.map.set(p.source, p);
  }

  get(source: string): FileSourceProvider | null {
    return this.map.get(source) ?? null;
  }

  has(source: string): boolean {
    return this.map.has(source);
  }

  /** Catalogue des types disponibles (pour l'UI admin). */
  list(): ProviderDescriptor[] {
    return [...this.map.values()].map((p) => p.describe());
  }
}
