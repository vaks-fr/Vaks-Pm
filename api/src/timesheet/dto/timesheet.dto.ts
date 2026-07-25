import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Query du endpoint `GET /timesheet?from=...&to=...&userId?=`.
 * Si `userId` est absent, on tape sur l'utilisateur courant. Bornes inclusives.
 */
export class TimesheetQueryDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  /** UUID ou 'me' (default = self). */
  @IsOptional()
  @IsString()
  userId?: string;
}
