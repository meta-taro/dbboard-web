import { IsNotEmpty, IsString } from "class-validator";

// Body schema for POST /connections. 0003 only persists the label and
// the driver discriminator; 0004 will add `connection_string` (validated
// here, never returned by GET /connections).
export class RegisterConnectionDto {
  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsString()
  @IsNotEmpty()
  driver!: string;
}
