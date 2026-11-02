-- Four individually specified identities (at most); never accept a wildcard,
-- NULL, a duplicate, an incomplete E.164 string or an active empty channel.
ALTER TABLE public.whatsapp_channels
  DROP CONSTRAINT whatsapp_allowed_senders,
  ADD CONSTRAINT whatsapp_allowed_senders CHECK (
    CASE
      WHEN cardinality(allowed_senders)=0 THEN NOT enabled
      WHEN cardinality(allowed_senders)>4 OR array_ndims(allowed_senders)<>1 OR array_lower(allowed_senders,1)<>1 THEN false
      ELSE array_position(allowed_senders,NULL::text) IS NULL
        AND allowed_senders[1] ~ '^\+[1-9][0-9]{7,14}$'
        AND (cardinality(allowed_senders)<2 OR (allowed_senders[2] ~ '^\+[1-9][0-9]{7,14}$' AND allowed_senders[2] <> allowed_senders[1]))
        AND (cardinality(allowed_senders)<3 OR (allowed_senders[3] ~ '^\+[1-9][0-9]{7,14}$' AND allowed_senders[3] <> ALL(allowed_senders[1:2])))
        AND (cardinality(allowed_senders)<4 OR (allowed_senders[4] ~ '^\+[1-9][0-9]{7,14}$' AND allowed_senders[4] <> ALL(allowed_senders[1:3])))
    END
  );
