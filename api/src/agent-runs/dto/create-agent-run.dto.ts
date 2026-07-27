import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

/** Déclaration d'un run d'agent (coût réel). Un agent ne déclare que le sien. */
export class CreateAgentRunDto {
  @IsOptional()
  @IsUUID()
  taskId?: string;

  @IsOptional()
  @IsUUID()
  deliverableId?: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  tokensIn?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  tokensOut?: number;

  /** Coût réel en € (devise org). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  /**
   * Clé d'idempotence (optionnelle) : un retry avec la même clé met à jour le
   * run au lieu d'en créer un doublon (évite le double comptage du coût).
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  runKey?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}
