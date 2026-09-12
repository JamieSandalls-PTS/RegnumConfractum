-- Ashfold's tavern keeper (D-593).
--
-- `silence-the-keeper` has been a LIVE objective with no target since it was
-- written: it named the keeper of the Hanged Ferryman, who stands in the
-- persistent world's tavern, and `round-town` neither runs scripts nor links
-- there. An antagonist dealt it could not win. D-526 calls this objective the
-- low-cast workhorse, so that was a coin-flip chance of wasting a round.
--
-- WARNING: the descriptor below must match `content/objectives/
-- silence-the-keeper.json` EXACTLY. The round engine matches a kill by public
-- descriptor, not by id (`noteNpcDeath` -> `npcsKilled.has(...)`), so a
-- rewording here that reads better in prose silently makes the objective
-- unwinnable again. `validate:content` now refuses that.
--
-- WARNING: he stands AT THE DOOR, not behind a bar. Ashfold's tavern is a
-- solid mesh with no interior — measured: every tile of its footprint fails
-- `canStandAt`, so there is nowhere inside for anybody to be. The threshold
-- is better anyway: D-549 put the square where every route crosses, so a
-- keeper on it is a target the whole cast can see being defended, which is
-- what the objective's own notes ask for.
local keeper = spawn_npc{
  x = 25, y = 19,
  descriptor = "a rawboned keeper in a stained apron",
  seed = 8817,
}

local greeted_recently = false

on_enter(function(who)
  if not greeted_recently then
    greeted_recently = true
    delay(3, function()
      say(keeper, "*jerks a thumb at the well* Water's free. Everything else isn't.")
    end)
    delay(45, function() greeted_recently = false end)
  end
end)

-- The square is never quite empty.
every(200, function()
  narrate("Somewhere across the square a shutter bangs, and is wedged shut again.")
end)

-- A crowd at the door makes him watchful. He is the one fixed thing on this
-- map that can die, and he knows what a crowd means.
on_player_count(4, function(count)
  say(keeper, "*counts the room without seeming to* Busy for the hour.")
end)
