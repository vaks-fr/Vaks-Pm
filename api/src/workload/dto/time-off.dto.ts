import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TimeOffType } from '@db';

export class CreateTimeOffDto {
  @IsUUID()
  userId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsEnum(TimeOffType)
  type?: TimeOffType;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateTimeOffDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsEnum(TimeOffType)
  type?: TimeOffType;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  notes?: string | null;
}

export class ListTimeOffsQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

/**
 * Une entrée de bulk-upsert. L'utilisateur cible est résolu par
 * `userId` (UUID interne), `employeeId` (RH) ou `email`, dans cet
 * ordre de priorité. Au moins un des trois doit être fourni.
 */
export class BulkTimeOffItem {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsEnum(TimeOffType)
  type?: TimeOffType;

  @IsOptional()
  @IsString()
  notes?: string;

  /**
   * Clé fournie par le système amont — clé d'idempotence (upsert sur
   * `[organizationId, source, externalId]`). Si omise, un nouvel
   * enregistrement est créé à chaque appel.
   */
  @IsOptional()
  @IsString()
  externalId?: string;
}

export class BulkUpsertTimeOffsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => BulkTimeOffItem)
  items!: BulkTimeOffItem[];

  /** Origine pour les nouveaux enregistrements. Défaut : API. */
  @IsOptional()
  @IsIn(['IMPORT', 'API'])
  source?: 'IMPORT' | 'API';
}

export class ImportTimeOffsCsvDto {
  /**
   * Contenu CSV brut. Colonnes reconnues (en-têtes obligatoires, ordre libre) :
   *   employeeId | email | userId   (au moins une)
   *   startDate, endDate            (selon `dateFormat` ou la locale org)
   *   type                          (optionnel, défaut VACATION)
   *   notes                         (optionnel)
   *   externalId                    (optionnel, clé d'idempotence)
   */
  @IsString()
  csv!: string;

  /**
   * Format de date des colonnes startDate/endDate :
   *   iso → YYYY-MM-DD
   *   eu  → DD/MM/YYYY ou DD-MM-YYYY
   *   us  → MM/DD/YYYY ou MM-DD-YYYY
   * Par défaut, on lit le `locale` de l'organisation (en-US → us, sinon eu).
   * Les dates ISO YYYY-MM-DD sont toujours acceptées, quel que soit ce flag.
   */
  @IsOptional()
  @IsIn(['iso', 'eu', 'us'])
  dateFormat?: 'iso' | 'eu' | 'us';
}
