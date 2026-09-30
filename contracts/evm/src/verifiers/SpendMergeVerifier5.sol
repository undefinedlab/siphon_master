// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 merge5 zkey sha256=1b190db0304251539d80337e5b5946b4a6536b4cb60aacb6484fb8f2698f521b
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendMergeVerifier5 {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 6577215360571027353983974682168925575125559436730675602607474941716066330296;
    uint256 constant IC0y = 4839017339444696543490026255222313977988191751311267562180794425678098790953;

    uint256 constant IC1x = 16666264001191135957844041916650313243082768608633050734168516121974885274287;
    uint256 constant IC1y = 11085133483570990141979304890896613915631558563423544242079108558973317974991;

    uint256 constant IC2x = 16653285192008955415340415207553497500836054164010112453932705750244274318372;
    uint256 constant IC2y = 7179352285634883901559191427695975016652229518940711442829621249355566807517;

    uint256 constant IC3x = 13740590366384064907715675772282025969792961708936261209259310248540105277941;
    uint256 constant IC3y = 16035426884839969094746711626585071008876357669971379022956392329648218931856;

    uint256 constant IC4x = 20321213285302877707344348221004812942122580253724748574146326688724237860865;
    uint256 constant IC4y = 3210463806126157643979606286922961163858979321931821136562599097615243388880;

    uint256 constant IC5x = 2263571537419387927044873730902478067390851631953693160913953588686888357697;
    uint256 constant IC5y = 13198343944730272175897114298788933108590281051856412670988527183276942657838;

    uint256 constant IC6x = 6620255494288624012226851390932851747443963209634575998464804315096399457852;
    uint256 constant IC6y = 18316603344859321267882059290764267294817620774758704557487677067798351368811;

    uint256 constant IC7x = 4387031633774688721767499497510134620698986720116642923703405738703794215468;
    uint256 constant IC7y = 19016402860181669913743208741296133593216110179521431242586508964766479179878;

    uint256 constant IC8x = 4339263199269735965853483268804932052077688026920016635005407668261705326818;
    uint256 constant IC8y = 11574669195193390153653872507893833691688780122899489864810364055405749381865;

    uint256 constant IC9x = 11943713968286093343662748280506990214720485333701214790573936117858820577072;
    uint256 constant IC9y = 20661407977731516721776059001162110445706832483521340399877013825401458000486;

    uint256 constant IC10x = 14961215958311228039972506910097402408854098232091716409051983397392755477940;
    uint256 constant IC10y = 14922797857630372341519822029224642674042466644432093132514375469469926953546;

    uint256 constant IC11x = 12199243145279924082493975677199820164246617519814950575333772489125570933241;
    uint256 constant IC11y = 12389896068944192487108062680853125921342056545597493359366822285254430001351;

    uint256 constant IC12x = 6855072469882842650372935549819460725188480630713374243336794493771933045983;
    uint256 constant IC12y = 15946873181459311580290102565210257340893851529609130013260355458715210823857;

    uint256 constant IC13x = 11964728947694420333154632510102883571380061799440907092117064234373193109790;
    uint256 constant IC13y = 19259693100005292143724268604650371597035006752024633175487840610515001073143;

    uint256 constant IC14x = 7898897204282853697426064813839216626705231075229549562890481868074273312608;
    uint256 constant IC14y = 1540838546002980820467391297550199720035426873633098159304178787889452416656;

    uint256 constant IC15x = 9981651303158202544815732539858129304274139644200561761635403537110300771062;
    uint256 constant IC15y = 8870781614356315068240989850626981545917779598344527527273259049696573695258;

    uint256 constant IC16x = 18935735679783257766311094334486672259734386597230457371145900228317246289440;
    uint256 constant IC16y = 17903915257467440435896925684108862559495761259819207335753163808598879551796;

    uint256 constant IC17x = 9091934344737591523683111799331948172566189767760141292016335724054723382627;
    uint256 constant IC17y = 19424605632302474806477205285695044550915849324425363010498189167854447533137;

    uint256 constant IC18x = 5793285333470432178634193732542913699937744593318472208874928388012038754795;
    uint256 constant IC18y = 6262977538602002509330998407296697288232403308135130565952760180879603979636;

    uint256 constant IC19x = 12802723629684952069509212260393688870282867038780155319132335735711496761768;
    uint256 constant IC19y = 2161378790364917348415975244362774459919628669507248368984183037821018931889;

    uint256 constant IC20x = 2599984681751296085381751182150019561041753357165394174970651582605650364087;
    uint256 constant IC20y = 19652887368751483757315422341892993769520199066913326206335080303418530789703;

    uint256 constant IC21x = 20333419732407484790461443955972568280445008272001398235888575059232282199327;
    uint256 constant IC21y = 19206524961261502712088643721120307199331120565535627247213290913419108904653;

    uint256 constant IC22x = 17764816029238687920345540656794294330239065139123836162772471194852328352132;
    uint256 constant IC22y = 16281408708071536953842987558921188153538601388792423859755626371052084052186;

    uint256 constant IC23x = 19476777066829953097719698800420803261647278355219739932954012032680657013881;
    uint256 constant IC23y = 4788946711440663754170507009019071826825398864965339900497172554418237243583;

    uint256 constant IC24x = 5115633623769560200795029023986221146627010767561956629076089203942607622466;
    uint256 constant IC24y = 9515244476946588836471894521063580416507416704188487763438625162358277179376;

    uint256 constant IC25x = 12459259699212033081326506734767543113885444510377666826517059837825944153171;
    uint256 constant IC25y = 17213583126543720693684588097677665213596777843848730800991452286693341561586;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
