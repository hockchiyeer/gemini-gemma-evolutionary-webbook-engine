"""Usage:  pip install gguf numpy && python3 scripts/make-tiny-gguf.py tests/fixtures/tiny-random.gguf

Builds tests/fixtures/tiny-random.gguf: a 2-layer, 32-dim llama-architecture model with RANDOM weights and a byte-level
tokenizer. It generates nonsense text, which is the point: it lets the test-suite load a real GGUF into the real llama.cpp
runtime and check the plumbing (load, context, JSON-schema grammar, generation, abort) in ~50 KB instead of a 3 GB download."""
import sys, numpy as np, gguf

out = sys.argv[1]
rng = np.random.default_rng(7)
n_embd, n_head, n_layer, n_ff, n_ctx = 32, 4, 2, 64, 512

# vocabulary: <unk>, <s>, </s>, 256 byte tokens, then the space marker and a-z so ordinary text tokenises sensibly
tokens = ["<unk>", "<s>", "</s>"] + [f"<0x{b:02X}>" for b in range(256)] + ["\u2581"] + [chr(c) for c in range(ord("a"), ord("z") + 1)]
types = [2, 3, 3] + [6] * 256 + [1] * (1 + 26)
scores = [0.0, 0.0, 0.0] + [0.0] * 256 + [-1.0] * (1 + 26)
n_vocab = len(tokens)

w = gguf.GGUFWriter(out, "llama")
w.add_name("tiny-random-test-model")
w.add_context_length(n_ctx)
w.add_embedding_length(n_embd)
w.add_block_count(n_layer)
w.add_feed_forward_length(n_ff)
w.add_head_count(n_head)
w.add_head_count_kv(n_head)
w.add_layer_norm_rms_eps(1e-5)
w.add_rope_dimension_count(n_embd // n_head)
w.add_vocab_size(n_vocab)
w.add_file_type(gguf.LlamaFileType.ALL_F32)
w.add_tokenizer_model("llama")
w.add_token_list(tokens)
w.add_token_scores(scores)
w.add_token_types(types)
w.add_bos_token_id(1)
w.add_eos_token_id(2)
w.add_unk_token_id(0)
w.add_add_bos_token(True)
w.add_add_eos_token(False)

def mat(*shape):
    return (rng.standard_normal(shape) * 0.08).astype(np.float32)

w.add_tensor("token_embd.weight", mat(n_vocab, n_embd))
w.add_tensor("output_norm.weight", np.ones(n_embd, dtype=np.float32))
w.add_tensor("output.weight", mat(n_vocab, n_embd))
for i in range(n_layer):
    w.add_tensor(f"blk.{i}.attn_norm.weight", np.ones(n_embd, dtype=np.float32))
    w.add_tensor(f"blk.{i}.attn_q.weight", mat(n_embd, n_embd))
    w.add_tensor(f"blk.{i}.attn_k.weight", mat(n_embd, n_embd))
    w.add_tensor(f"blk.{i}.attn_v.weight", mat(n_embd, n_embd))
    w.add_tensor(f"blk.{i}.attn_output.weight", mat(n_embd, n_embd))
    w.add_tensor(f"blk.{i}.ffn_norm.weight", np.ones(n_embd, dtype=np.float32))
    w.add_tensor(f"blk.{i}.ffn_gate.weight", mat(n_ff, n_embd))
    w.add_tensor(f"blk.{i}.ffn_up.weight", mat(n_ff, n_embd))
    w.add_tensor(f"blk.{i}.ffn_down.weight", mat(n_embd, n_ff))

w.write_header_to_file()
w.write_kv_data_to_file()
w.write_tensors_to_file()
w.close()
print("wrote", out)
