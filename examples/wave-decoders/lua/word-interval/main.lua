local decoder = {}

function decoder.init()
  return {}
end

local function close(ctx, state, finish)
  if state.tick and state.tick ~= finish and state.value == "10101010" then
    ctx.emit({ start = state.tick, ["end"] = finish, label = "word 0xaa" })
  end
end

function decoder.decode(ctx, state, batch)
  for _, event in ipairs(batch.events) do
    close(ctx, state, event.tick)
    state.tick = event.tick
    state.value = event.value
  end
  state.finish = batch["end"]
end

function decoder.flush(ctx, state)
  close(ctx, state, state.finish)
end

function decoder.save_state(state)
  return state
end

function decoder.restore_state(state)
  return state
end

return decoder
