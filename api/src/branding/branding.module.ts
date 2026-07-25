import { Module } from '@nestjs/common';
import { BrandingController } from './branding.controller';

/**
 * Gestion du branding org (logo, à terme : favicon, palette). L'upload se fait
 * via MinIO (bucket `branding`) ; la lecture publique passe par l'API sous
 * `/public/branding/...` pour rester accessible aux clients mail sans auth.
 */
@Module({
  controllers: [BrandingController],
})
export class BrandingModule {}
