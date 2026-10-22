import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias financeiras vivem aqui, não só no código:
 * unicidade (idempotência), não-negatividade, aritmética do ledger,
 * imutabilidade do ledger e do estado terminal, e saldo ⇄ ledger.
 */
export class Migration20261022000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   uuid NOT NULL,
        currency    char(3) NOT NULL CONSTRAINT ck_wallets_currency CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) NOT NULL CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        version     integer NOT NULL CONSTRAINT ck_wallets_version CHECK (version >= 1),
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      );`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL,
        external_transaction_id           text NOT NULL,
        idempotency_key                   text NOT NULL,
        payload_hash                      text NOT NULL,
        wallet_id                         uuid NOT NULL REFERENCES wallets (id),
        player_id                         uuid NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL CONSTRAINT ck_wager_kind
                                            CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) NOT NULL,
        currency                          char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid REFERENCES wager_transactions (id),
        status                            text NOT NULL CONSTRAINT ck_wager_status
                                            CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text,
        result_balance                    numeric(20,2),
        reference_attempts                integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_attempt_at         timestamptz,
        created_at                        timestamptz NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wager_amount CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT ck_wager_reversal_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_failure_code CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wager_processed_at
          CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR processed_at IS NOT NULL)
      );`);

    // Uma referência só pode ser revertida uma vez (REFUND ou ROLLBACK), mesmo com várias instâncias.
    this.addSql(`
      CREATE UNIQUE INDEX ux_wager_single_reversal ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';`);
    this.addSql(`
      CREATE INDEX ix_wager_pending_reference ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX ix_wager_wallet ON wager_transactions (wallet_id);`);

    // Estado terminal e campos de negócio não mudam; transações nunca são apagadas.
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions are append-only' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id,
            NEW.player_id, NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id)
           IS DISTINCT FROM
           (OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id,
            OLD.player_id, OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id) THEN
          RAISE EXCEPTION 'business fields of wager transaction % are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;`);
    this.addSql(`
      CREATE TRIGGER trg_wager_transactions_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq             bigserial NOT NULL UNIQUE,
        id              uuid PRIMARY KEY,
        wallet_id       uuid NOT NULL REFERENCES wallets (id),
        transaction_id  uuid NOT NULL REFERENCES wager_transactions (id),
        direction       text NOT NULL CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2) NOT NULL CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
        currency        char(3) NOT NULL,
        balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2) NOT NULL CONSTRAINT ck_ledger_balance_non_negative CHECK (balance_after >= 0),
        created_at      timestamptz NOT NULL,
        CONSTRAINT uq_ledger_transaction UNIQUE (transaction_id),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount))
      );`);
    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq);`);

    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries are append-only (% blocked)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$;`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_append_only();`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();`);

    // No commit, o saldo da wallet precisa ser igual ao último balance_after do seu ledger.
    this.addSql(`
      CREATE FUNCTION wallet_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        current_balance numeric(20,2);
        last_balance    numeric(20,2);
      BEGIN
        SELECT balance INTO current_balance FROM wallets WHERE id = NEW.id;
        SELECT balance_after INTO last_balance FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
        IF current_balance IS DISTINCT FROM COALESCE(last_balance, 0) THEN
          RAISE EXCEPTION 'wallet % balance % does not match ledger %', NEW.id, current_balance, COALESCE(last_balance, 0)
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$;`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_balance_matches_ledger
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_balance_matches_ledger();`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id    text NOT NULL,
        payload_hash  text NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid PRIMARY KEY,
        aggregate_id    text NOT NULL,
        event_type      text NOT NULL,
        payload         jsonb NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at    timestamptz
      );`);
    this.addSql(`CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_balance_matches_ledger ON wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_balance_matches_ledger();`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_append_only();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_transactions_guard();`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
