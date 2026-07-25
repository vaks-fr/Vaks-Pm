import { IsString, Length } from 'class-validator';

export class CreateCommentDto {
  @IsString()
  @Length(1, 10_000)
  body!: string;
}

export class UpdateCommentDto {
  @IsString()
  @Length(1, 10_000)
  body!: string;
}
