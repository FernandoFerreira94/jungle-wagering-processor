import { Migration } from '@mikro-orm/migrations';

/** Completa a proteção existente sem reescrever a migration já aplicada. */
export class Migration20261024000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION ledger_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        wallet_currency char(3);
        previous_balance numeric(20,2);
        previous_seq bigint;
      BEGIN
        -- A mesma unidade de lock da aplicação, inclusive para inserções SQL diretas.
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
        SELECT balance_after, seq INTO previous_balance, previous_seq FROM wallet_ledger_entries
          WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
        IF NEW.balance_before IS DISTINCT FROM COALESCE(previous_balance, 0)
           OR NEW.seq <= COALESCE(previous_seq, 0) OR NEW.currency IS DISTINCT FROM wallet_currency THEN
          RAISE EXCEPTION 'invalid ledger chain for wallet %', NEW.wallet_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_chain_guard BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_chain_guard();`);

    this.addSql(`
      CREATE OR REPLACE FUNCTION wallet_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        affected_wallet uuid;
        current_balance numeric(20,2);
        last_balance numeric(20,2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN affected_wallet := NEW.id;
        ELSE affected_wallet := NEW.wallet_id;
        END IF;
        SELECT balance INTO current_balance FROM wallets WHERE id = affected_wallet;
        SELECT balance_after INTO last_balance FROM wallet_ledger_entries
          WHERE wallet_id = affected_wallet ORDER BY seq DESC LIMIT 1;
        IF current_balance IS DISTINCT FROM COALESCE(last_balance, 0) THEN
          RAISE EXCEPTION 'wallet % balance does not match ledger', affected_wallet
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$;`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_ledger_balance_matches_wallet AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_balance_matches_ledger();`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER trg_ledger_balance_matches_wallet ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER trg_ledger_chain_guard ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION ledger_chain_guard();`);
    this.addSql(`
      CREATE OR REPLACE FUNCTION wallet_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        current_balance numeric(20,2);
        last_balance numeric(20,2);
      BEGIN
        SELECT balance INTO current_balance FROM wallets WHERE id = NEW.id;
        SELECT balance_after INTO last_balance FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
        IF current_balance IS DISTINCT FROM COALESCE(last_balance, 0) THEN
          RAISE EXCEPTION 'wallet % balance does not match ledger', NEW.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$;`);
  }
}
