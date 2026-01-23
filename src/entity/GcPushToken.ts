import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity()
export class GcPushToken {
  // identity = wallet address (bc1..., etc.)
  @PrimaryColumn({ type: 'varchar', length: 128 })
  address!: string;

  // e.g. "android" | "ios"
  @PrimaryColumn({ type: 'varchar', length: 16 })
  platform!: string;

  // FCM/APNS token
  @Column({ type: 'text' })
  token!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
