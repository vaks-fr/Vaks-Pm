import { IsArray, IsString } from 'class-validator';

/** Nouvel ordre/masquage de widgets choisi par l'utilisateur (self-service). */
export class UpdateReportWidgetsDto {
  @IsArray()
  @IsString({ each: true })
  widgetOrder!: string[];

  @IsArray()
  @IsString({ each: true })
  hiddenKeys!: string[];
}
