import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class ReorderColumnsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  columnIds!: string[];
}
