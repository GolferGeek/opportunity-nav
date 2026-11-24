-- The model the agent said it's running (or was started with), from its session event. Null = not reported.
alter table jobs add column reported_model text;
