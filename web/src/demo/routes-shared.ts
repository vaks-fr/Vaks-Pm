/* ============================================================
   Vaks — Démo statique : primitives partagées du routage.
   ----------------------------------------------------------------
   Isolées ici pour casser le cycle d'import routes.ts ↔ mutations.ts
   (les deux ont besoin de `DemoHttpError`).
   ============================================================ */

/** Résultat d'un handler : valeur JSON, `Response` brute, ou `undefined` (204). */
export type DemoResult = unknown;

/** Erreur HTTP simulée (emballée en Response au format NestJS par le handler). */
export class DemoHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DemoHttpError';
    this.status = status;
  }
}
