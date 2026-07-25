import { BadRequestException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { isCommonPassword } from './common-passwords';

export type ComplexityLevel = 'Low' | 'Medium' | 'High';

export interface ResolvedPolicy {
  minLength: number;
  complexity: ComplexityLevel;
  historyCount: number; // 0 = désactivé
  expiryDays: number;   // 0 = jamais
  checkCommonPasswords: boolean; // bloque les mots de passe triviaux (top ~500)
}

/**
 * Politique de mot de passe org-scopée. Toutes les valeurs viennent des
 * `OrgSetting` (clés héritées du panneau Admin Security & Compliance) :
 *
 *   - `pwMinLength`     : longueur minimale (chars). Défaut 12.
 *   - `pwComplexity`    : 'Low' | 'Medium' | 'High'. Défaut 'High'.
 *   - `pwHistory`       : nombre de derniers hashes contre lesquels on
 *                         empêche la réutilisation. Défaut 5.
 *   - `pwExpiry`        : durée d'expiration en jours, 0 = jamais. Défaut 90.
 *
 * Complexité — règles cumulatives :
 *   Low    : au moins 1 lettre + 1 chiffre.
 *   Medium : Low + 1 minuscule ET 1 majuscule.
 *   High   : Medium + 1 caractère spécial (\W ou _).
 */
@Injectable()
export class PasswordPolicyService {
  private static readonly DEFAULT_MIN_LENGTH = 12;
  private static readonly DEFAULT_COMPLEXITY: ComplexityLevel = 'High';
  private static readonly DEFAULT_HISTORY = 5;
  private static readonly DEFAULT_EXPIRY_DAYS = 90;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
  ) {}

  async resolve(orgId: string): Promise<ResolvedPolicy> {
    const all = await this.settings.getAll(orgId);
    const minLength = num(all['pwMinLength'], PasswordPolicyService.DEFAULT_MIN_LENGTH);
    const complexityRaw = String(all['pwComplexity'] ?? '').trim();
    const complexity: ComplexityLevel =
      complexityRaw === 'Low' || complexityRaw === 'Medium' || complexityRaw === 'High'
        ? complexityRaw
        : PasswordPolicyService.DEFAULT_COMPLEXITY;
    const historyCount = Math.max(0, num(all['pwHistory'], PasswordPolicyService.DEFAULT_HISTORY));
    const expiryDays = Math.max(0, num(all['pwExpiry'], PasswordPolicyService.DEFAULT_EXPIRY_DAYS));
    // Par défaut ON : la liste embarquée est petite et bloque uniquement les
    // vrais classiques. Toggle à false dans l'admin si nécessaire (peu de raisons).
    const checkCommonPasswords = bool(all['security.checkCommonPasswords'], true);
    return { minLength, complexity, historyCount, expiryDays, checkCommonPasswords };
  }

  /** Lève BadRequestException si la policy n'est pas respectée. */
  async validateStrength(orgId: string, password: string): Promise<void> {
    const p = await this.resolve(orgId);
    const errors: string[] = [];
    if (!password || password.length < p.minLength) {
      errors.push(`Le mot de passe doit faire au moins ${p.minLength} caractères.`);
    }
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);
    const hasLetter = hasLower || hasUpper;
    if (p.complexity === 'Low') {
      if (!hasLetter) errors.push('Au moins une lettre est requise.');
      if (!hasDigit) errors.push('Au moins un chiffre est requis.');
    } else if (p.complexity === 'Medium') {
      if (!hasLower) errors.push('Au moins une minuscule est requise.');
      if (!hasUpper) errors.push('Au moins une majuscule est requise.');
      if (!hasDigit) errors.push('Au moins un chiffre est requis.');
    } else {
      // High
      if (!hasLower) errors.push('Au moins une minuscule est requise.');
      if (!hasUpper) errors.push('Au moins une majuscule est requise.');
      if (!hasDigit) errors.push('Au moins un chiffre est requis.');
      if (!hasSpecial) errors.push('Au moins un caractère spécial est requis.');
    }
    // Common-password check : indépendant de la complexité (un mot de passe
    // peut respecter "complexité High" mais être "Password1!" → triviale).
    if (p.checkCommonPasswords && isCommonPassword(password)) {
      errors.push('Ce mot de passe figure dans la liste des mots de passe communs. Choisissez-en un moins prévisible.');
    }
    if (errors.length) {
      throw new BadRequestException({
        error: 'PASSWORD_POLICY_VIOLATION',
        message: errors,
      });
    }
  }

  /** Vérifie que le nouveau mot de passe n'a pas été utilisé dans les N derniers. */
  async checkHistory(orgId: string, userId: string, newPlain: string): Promise<void> {
    const p = await this.resolve(orgId);
    if (p.historyCount === 0) return;
    // Inclus le hash courant : on ne veut pas non plus laisser remettre le même.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    const candidates: string[] = [];
    if (user?.passwordHash) candidates.push(user.passwordHash);
    const past = await this.prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: p.historyCount,
      select: { passwordHash: true },
    });
    for (const r of past) candidates.push(r.passwordHash);
    for (const h of candidates) {
      try {
        if (await argon2.verify(h, newPlain)) {
          throw new BadRequestException({
            error: 'PASSWORD_REUSED',
            message: `Ce mot de passe a déjà été utilisé récemment. Choisissez-en un différent (les ${p.historyCount} derniers sont bloqués).`,
          });
        }
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        // hash corrompu → on ignore et passe au suivant
      }
    }
  }

  /**
   * Enregistre le hash courant dans l'historique APRÈS qu'un nouveau hash a
   * été posé sur le user. Trimme à `historyCount` entrées.
   * `previousHash` peut être null (création initiale d'un user).
   */
  async recordHistory(orgId: string, userId: string, previousHash: string | null): Promise<void> {
    const p = await this.resolve(orgId);
    if (p.historyCount === 0 || !previousHash) return;
    await this.prisma.passwordHistory.create({
      data: { userId, passwordHash: previousHash },
    });
    // Trim
    const extras = await this.prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: p.historyCount,
      select: { id: true },
    });
    if (extras.length) {
      await this.prisma.passwordHistory.deleteMany({
        where: { id: { in: extras.map((e) => e.id) } },
      });
    }
  }

  /** True si le mot de passe est expiré selon la policy. */
  isExpired(p: ResolvedPolicy, passwordChangedAt: Date | null, fallback: Date): boolean {
    if (p.expiryDays <= 0) return false;
    const ref = passwordChangedAt ?? fallback;
    const ageMs = Date.now() - ref.getTime();
    return ageMs > p.expiryDays * 86_400_000;
  }
}

function num(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : def;
}

function bool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return def;
}
