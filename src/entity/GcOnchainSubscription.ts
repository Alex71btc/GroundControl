import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity()
@Index(['address', 'subscriberAddress'], { unique: true })
export class GcOnchainSubscription {
  @PrimaryGeneratedColumn()
  id!: number;

  // the on-chain address we watch (bc1..., 1..., 3...)
  @Column({ type: 'varchar', length: 128 })
  address!: string;

  // the wallet/user identity from JWT (your signer address)
  @Column({ type: 'varchar', length: 128 })
  subscriberAddress!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
