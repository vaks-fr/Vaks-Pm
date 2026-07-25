import { IsOptional, IsString, Length, Matches } from 'class-validator';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class CreateLabelDto {
  @IsString()
  @Length(1, 50)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'color: format #rrggbb' })
  color?: string;
}

export class UpdateLabelDto {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'color: format #rrggbb' })
  color?: string;
}
