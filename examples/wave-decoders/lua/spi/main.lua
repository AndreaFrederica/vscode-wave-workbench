local decoder = {}

function decoder.init(ctx)
  return { clock = tostring(ctx.getOption("cpol") or 0), data = "x", select = "1", bits = "" }
end

function decoder.decode(ctx, state, batch)
  local polarity = tostring(ctx.getOption("cpol") or 0)
  local trailing = (ctx.getOption("cpha") or 0) == 1
  local tick, old_clock
  local function apply()
    if not tick then return end
    if state.select ~= "0" then
      state.bits = ""
    elseif old_clock ~= state.clock and old_clock:match("^[01]$") and state.clock:match("^[01]$")
        and ((state.clock == polarity) == trailing) then
      if #state.bits == 0 then state.first = tick end
      state.bits = state.bits .. state.data
      if #state.bits == 8 then
        local value = tonumber(state.bits, 2)
        local label = value and string.format("0x%02x", value) or state.bits
        ctx.emit({ start = state.first, ["end"] = tick, label = label })
        state.bits = ""
      end
    end
  end
  for _, event in ipairs(batch.events) do
    if tick ~= event.tick then
      apply()
      tick, old_clock = event.tick, state.clock
    end
    if event.input == 0 then state.clock = event.value
    elseif event.input == 1 then state.data = event.value
    elseif event.input == 2 then state.select = event.value end
  end
  apply()
end

function decoder.save_state(state) return state end
function decoder.restore_state(state) return state end
return decoder
