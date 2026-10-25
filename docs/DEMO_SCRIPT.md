# Two-minute demo: what to record

Record with QuickTime (File > New Screen Recording, microphone on). Use your own voice: that's
the point of the demo. Before recording, start MaintainOps or Odoo, Ollama and the voice server,
and do one throwaway turn so the models are loaded.

1. **(15 s) The problem.** "A technician finishes a repair and has to type the log on a shop
   tablet. This lets them say it instead, and it writes into the maintenance system they
   already use, through its API."
2. **(40 s) A log with a mistake in it.** Pick a technician, press Record and say: *"Changed one
   air filter on the generator, thirty minutes."* The agent asks which generator. Answer *"Generator
   two."* It reads the exact record back. Say *"No, forty-five minutes."* It reads it back
   again. Say *"Yes."*
3. **(25 s) Show it landed.** Open the record in the backend (MaintainOps equipment history, or
   the Odoo maintenance request with its technician, duration and parts transfer). Point at the
   review queue entry for the corrected read-back.
4. **(25 s) Why it's built this way.** "The model can't save anything. It has no submit tool.
   The read-back and the yes are plain code. In my first eval run the model wrote three wrong
   records; with this design it's written zero in every run since."
5. **(15 s) Close.** "Same agent, two backends: my own MaintainOps, and Odoo, which I don't own."

Keep it under 2:30. Upload to YouTube (unlisted) or Loom and put the link at the top of the README.
