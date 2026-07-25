import { IsUUID } from 'class-validator';

export class AssignManagerDto {
  @IsUUID()
  userId!: string;
}
