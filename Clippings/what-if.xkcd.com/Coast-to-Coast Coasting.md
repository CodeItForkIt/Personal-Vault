---
title: Coast-to-Coast Coasting
source: https://what-if.xkcd.com/154/
author:
published:
created: 2026-06-28
description:
tags:
  - clippings
domain: xkcd.com
favicon: https://what-if.xkcd.com/favicon.ico
sticker: ""
---
What if the entire continental US was on a decreasing slope from West to East. How steep would the slope have to be to sustain the momentum needed to ride a bicycle the entire distance without pedaling?

—Brandon Rooks

Too steep to actually build, sadly. But for the next best thing, I suggest a vacation to the Hawaiian island of Maui.

![](https://what-if.xkcd.com/imgs/a/154/maui.png "I suspect this is the solution to many physics problems.")

First, the physics. Bikes coast downhill. On a long enough slope, a bike will reach a certain steady coasting speed. On a steep hill, their coasting speed will be faster, and on a gentle slope, they coast more slowly. If the slope is small enough, the bike will slow down and stop.

![](https://what-if.xkcd.com/imgs/a/154/slopes.png "I'm just gonna balance here until plate tectonics or something helps me out.")

The shallowest slope at which a bike will still roll steadily forward is determined by the bike's *coefficient of rolling resistance*. In fact, the formula for this minimum slope—measured in terms of vertical drop over horizontal distance—is incredibly simple:

$$
\text{Minimum slope} = \text{Coefficient of rolling resistance}
$$

"Slope equals coefficient of friction"\[1\] is a handy general rule in physics: The coefficient of friction between an object on a surface is just the shallowest slope at which the object slides.\[2\]

![](https://what-if.xkcd.com/imgs/a/154/tangent.png "Somehow, this makes me less nervous than seeing a glass sitting at the edge of a LEVEL table.")

For a nice bike under good conditions, the coefficient of rolling resistance can get as low as 0.002, or 1/500.\[3\] That means that to travel 500 miles horizontally, you'll need a vertical drop of at *least* 1 mile. To travel the roughly 2,500 miles from New York to LA, you'd need to start off at *least* 5 miles up, higher than North America's highest mountain. I suggest bringing oxygen tanks.

![](https://what-if.xkcd.com/imgs/a/154/distance.png "In this scenario, where there's a giant slope stretching across the entire country, I'm somehow stuck wondering about the agency that maintains this sign. How many other signs are there? Do they send someone up the mountain to repair it every so often? Is driving from NY in a vehicle a cheaper way to access it than building an elevator to take them straight up from LA? So many questions!")

But be warned—the trip could take a while.

A bike's rolling resistance mainly comes from the way the tire\[4\]\[5\]

And the spokes and frame, if your bike is made of soft clay or something.

\[6\] deforms as it rolls, and it doesn't depend that much on how fast you're going. Air resistance, on the other hand, increases as you speed up, and under most conditions is the main drag force acting on a moving bike. To figure out how fast a bike will coast on a downhill slope, you need to calculate the point at which air resistance balances out the forward pull from gravity. At that point, the bike will stop accelerating. We can do that by using the formula for air resistance:

$$
\text{Forward pull from gravity} = \text{Rolling resistance} + \text{Drag force}
$$

$$
m g sin \left(\theta\right) = g cos \left(\theta\right) C_{r} m + \frac{1}{2} C_{d} \rho A V^{2}
$$

$$
V = \sqrt{\frac{m g sin \left(\theta\right) - g cos \left(\theta\right) C_{r} m}{\frac{1}{2} C_{d} \rho A}}
$$

(*V* is the speed of the bike, *C <sub>r</sub>* and *C <sub>d</sub>* are the coefficients of rolling resistance and air drag, *θ* is the slope angle, *g* is the acceleration of gravity, *m* is the mass of the bike and rider, *A* is the frontal area of the bike and rider, and *ρ* is the density of air.)

For a very shallow slope of 0.2° or 0.3°, the bike would barely roll, and its top speed would be slower than a walking pace. You would need to add an extra few tenths of a degree to get the speed high enough to balance comfortably, and this would make the LA end of the slope even *higher* than the already implausible five miles.

But still, bicycles are pretty impressive coasting machines.\[7\] Skis, which are pretty good at sliding, actually have a coefficient of friction about 10 times higher than a bike's rolling resistance.

To ski from LA to New York, a skier would need to start off 10 times higher than a bike to make the same trip. Instead of the top of a mountain, they would need to start from near the edge of space. Not only is there no way to build a slope that tall, but ice isn't even stable at those low temperatures, so there'd be nothing to slide on.

![](https://what-if.xkcd.com/imgs/a/154/skiing.png "We could ski down the steep side.")

In practice, the longest horizontal distance you could travel on a bike with an ideal ramp is probably not more than a couple hundred miles, and that would require ideal conditions. In the real world, the longest such trip might\[8\] be the [Haleakala downhill bike ride](https://www.google.com/search?q=haleakala+downhill+bike+ride), which allows you to take a 35-mile trip from near the 10,000-foot summit all the way down to sea level with virtually no pedaling required.

![](https://what-if.xkcd.com/imgs/a/154/beach.png "If you aim for the right spot along the coast, you can probably get quite a few feet BELOW sea level without pedaling, although swimming back up with the bike might be hard.")

(And if you can't make it to Maui yourself, you can at least enjoy the video search results for [bicycle into water](https://www.google.com/search?q=bicycle+into+water&tbm=vid).)