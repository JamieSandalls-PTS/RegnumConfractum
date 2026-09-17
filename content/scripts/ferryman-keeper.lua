-- The Hanged Ferryman's keeper: the first scripted inhabitant (D-109).
-- Everything here runs through the sandboxed area API; there is no other way
-- for a script to touch the world.

-- Behind the bar, in the rebuilt 32x32 room (D-544). Who he is lives in
-- `content/npcs/ferryman-keeper.json` and where he stands is a placement on
-- this area (D-598); this file is only what he does.
local keeper = npc("ferryman-keeper")

local greeted_recently = false

on_enter(function(who)
  if not greeted_recently then
    greeted_recently = true
    delay(2, function()
      say(keeper, "*waves* Mind the mud. Benches are for paying folk.")
    end)
    -- Don't repeat the greeting for every soul in a crowd.
    delay(30, function() greeted_recently = false end)
  end
end)

-- The room breathes even when nobody speaks.
every(240, function()
  narrate("The candles gutter. Somewhere upstairs, a floorboard groans.")
end)

-- A full room makes the keeper nervous.
on_player_count(5, function(count)
  say(keeper, "*points* Whatever you lot are planning, plan it quieter.")
end)
